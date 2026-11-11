import OpenAI from 'openai';
import {
  DISK_PATHS,
  type AgentContext,
  type AgentId,
  type AnswerContext,
  type AnswerDraft,
  type RefereeContext,
  type RefereeQuestionDraft,
  type VoteContext,
  type VoteDecision,
} from '@susagent/shared';
import type { AgentEnv } from './env';
import { toolsFor } from './env';
import { fakeSourceUrl, heuristicQuestion } from './heuristic';
import { tokens } from './mockData';
import { lessonsPrompt } from './lessons';

const MAX_STEPS = 4;
// Reasoning models spend part of this on (minimal) reasoning tokens.
const MAX_TOKENS = 1500;

interface Tool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

const TOOL_DEFS: Record<string, Tool> = {
  web_search: {
    name: 'web_search',
    description: 'Search the live web for recent news. Limited budget per round; returns title/url/snippet results.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  read_my_disk: {
    name: 'read_my_disk',
    description: `Read a file from your private disk: ${DISK_PATHS.answers}, ${DISK_PATHS.suspects}, ${DISK_PATHS.notes}, ${DISK_PATHS.sourcesDir}/r<N>.md.`,
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  write_note: {
    name: 'write_note',
    description: 'Append a short private note to your notes.md (strategy, hunches).',
    input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  submit_answer: {
    name: 'submit_answer',
    description: 'FINAL: submit your public answer to the referee question. Ends your turn.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Short public answer, one sentence, under 200 chars.' },
        source_url: { type: 'string', description: 'URL you cite.' },
        copied_from: { type: 'string', description: 'Agent id whose revealed answer you based this on, if any.' },
        private_reasoning: { type: 'string', description: 'One private sentence on why (only the game master sees it).' },
      },
      required: ['text', 'private_reasoning'],
    },
  },
  cast_vote: {
    name: 'cast_vote',
    description: 'FINAL: publicly vote for the agent you want eliminated. Ends your turn.',
    input_schema: {
      type: 'object',
      properties: {
        target_id: { type: 'string', description: 'Agent id from the candidate list.' },
        reason: { type: 'string', description: 'One short public sentence.' },
        suspicion: {
          type: 'array',
          description: 'Suspicion 0..1 for the agents you have an opinion on.',
          items: {
            type: 'object',
            properties: { agent_id: { type: 'string' }, score: { type: 'number' } },
            required: ['agent_id', 'score'],
            additionalProperties: false,
          },
        },
        private_reasoning: { type: 'string', description: 'One private sentence (only the game master sees it).' },
      },
      // strict function calling: every property required, no extras (enum on target_id/agent_id added per call).
      required: ['target_id', 'reason', 'suspicion', 'private_reasoning'],
      additionalProperties: false,
    },
  },
  submit_question: {
    name: 'submit_question',
    description: 'FINAL: submit the round question with its answer key.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'One question with a short, checkable answer (a name, number, or place).' },
        answer_key: { type: 'string', description: 'The correct short answer.' },
        sources: { type: 'array', items: { type: 'string' }, description: 'URLs backing the answer key.' },
        private_reasoning: { type: 'string' },
      },
      required: ['text', 'answer_key', 'sources'],
    },
  },
};

let client: OpenAI | null = null;
const openai = () => (client ??= new OpenAI({ maxRetries: 1, timeout: 30_000 }));

/** LLM calls per game (for logs / reports). */
const callsByGame = new Map<string, number>();
export const llmCallCount = (gameId: string) => callsByGame.get(gameId) ?? 0;

/** Tools offered for a phase. web_search comes only from toolsFor(role), so impostors never see it. */
function toolsForPhase(env: AgentEnv, final: 'submit_answer' | 'cast_vote' | 'submit_question'): Tool[] {
  const allowed = toolsFor(env.role);
  const finals = ['submit_answer', 'cast_vote', 'submit_question'];
  return allowed.filter((n) => !finals.includes(n) || n === final).map((n) => TOOL_DEFS[n]!);
}

const toOpenAI = (t: Tool, strict = false): OpenAI.Chat.Completions.ChatCompletionTool => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.input_schema, ...(strict ? { strict: true } : {}) },
});

function parseArgs(raw: string | undefined): Record<string, any> {
  try {
    const v = JSON.parse(raw || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/** Generic tool-calling loop (OpenAI Chat Completions). Returns the final tool's arguments. Throws on API errors. */
async function runLoop(
  env: AgentEnv,
  round: number,
  topic: string,
  system: string,
  user: string,
  final: 'submit_answer' | 'cast_vote' | 'submit_question',
  opts: { forceFirstTool?: boolean; firstTool?: string; candidates?: string[] } = {},
): Promise<Record<string, any>> {
  const tools = toolsForPhase(env, final).map((t) => {
    // Votes: strict schema with target_id / agent_id restricted to the valid candidates.
    if (t.name !== 'cast_vote' || !opts.candidates?.length) return toOpenAI(t);
    const schema = structuredClone(t.input_schema) as any;
    schema.properties.target_id.enum = opts.candidates;
    schema.properties.suspicion.items.properties.agent_id.enum = opts.candidates;
    return toOpenAI({ ...t, input_schema: schema }, true);
  });
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: system + lessonsPrompt(env.opts.lessons ?? []) },
    { role: 'user', content: user },
  ];
  for (let step = 0; step < MAX_STEPS; step++) {
    const last = step === MAX_STEPS - 1;
    const tool_choice: OpenAI.Chat.Completions.ChatCompletionToolChoiceOption = last
      ? { type: 'function', function: { name: final } }
      : step === 0 && opts.firstTool && tools.some((t) => t.type === 'function' && t.function.name === opts.firstTool)
        ? { type: 'function', function: { name: opts.firstTool } }
        : step === 0 && opts.forceFirstTool
          ? 'required'
          : 'auto';
    callsByGame.set(env.opts.gameId, llmCallCount(env.opts.gameId) + 1);
    const res = await openai().chat.completions.create({
      model: env.model,
      max_completion_tokens: MAX_TOKENS,
      reasoning_effort: 'minimal',
      messages,
      tools,
      tool_choice,
    });
    const msg = res.choices[0]?.message;
    if (!msg) throw new Error('empty completion');
    const calls = (msg.tool_calls ?? []).filter((c): c is OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall => c.type === 'function');
    const finalCall = calls.find((c) => c.function.name === final);
    if (finalCall) return parseArgs(finalCall.function.arguments);
    messages.push(calls.length ? { role: 'assistant', content: msg.content ?? null, tool_calls: calls } : { role: 'assistant', content: msg.content ?? '' });
    if (!calls.length) {
      messages.push({ role: 'user', content: `Call ${final} now.` });
      continue;
    }
    for (const c of calls) {
      const input = parseArgs(c.function.arguments);
      let out: string;
      if (c.function.name === 'web_search' && env.hasWebSearch) {
        const r = await env.search(round, String(input.query ?? ''), topic);
        out = r
          ? JSON.stringify(r.map((x) => ({ title: x.title, url: x.url, snippet: x.snippet })))
          : `Search denied: budget exhausted (${env.config.searchBudgetPerRound}/round). Answer with what you have.`;
      } else if (c.function.name === 'read_my_disk') {
        out = ((await env.disk.read(String(input.path ?? ''))) ?? '(file not found)').slice(0, 3000);
      } else if (c.function.name === 'write_note') {
        await env.appendNote(String(input.text ?? '').slice(0, 300));
        out = 'saved';
      } else {
        out = `Tool ${c.function.name} is not available to you.`;
      }
      messages.push({ role: 'tool', tool_call_id: c.id, content: out });
    }
  }
  throw new Error('tool loop ended without a final answer');
}

/* ------------------------------------------------------------------ */
/* Prompt building                                                     */
/* ------------------------------------------------------------------ */

const nameMap = (ctx: AgentContext) => new Map(ctx.alive.map((a) => [a.id, a.name]));

function history(ctx: AgentContext): string {
  const names = nameMap(ctx);
  const lines: string[] = [];
  const recentRounds = new Set([ctx.round - 1, ctx.round - 2]);
  for (const q of ctx.questions.filter((q) => recentRounds.has(q.round))) {
    lines.push(`Round ${q.round} Q: ${q.text}`);
    for (const a of ctx.answers.filter((a) => a.questionId === q.id)) lines.push(`  ${a.agentId} (${names.get(a.agentId) ?? 'out'}): ${a.text}`);
  }
  const votes = ctx.pastVotes.filter((v) => recentRounds.has(v.round));
  if (votes.length) lines.push('Recent votes: ' + votes.map((v) => `${v.voterId}->${v.targetId}`).join(', '));
  if (ctx.eliminated.length) lines.push('Eliminated: ' + ctx.eliminated.map((e) => `${e.agentId} (r${e.round}, was ${e.role})`).join(', '));
  return lines.join('\n') || '(first round)';
}

const RULES = `Game "SusAgent": AI agents answer a referee's recent-news question each round. Answers are sealed (nobody sees others' answers until all are revealed). Then everyone publicly votes out who they think is an impostor. Crewmates have a web_search tool; impostors do not and must bluff. Crew wins when all impostors are out; impostors win at parity or by surviving the last round.`;

function systemFor(env: AgentEnv, ctx: AgentContext): string {
  const me = `You are ${ctx.self.name} (id ${ctx.self.id}). Round ${ctx.round}/${ctx.totalRounds}.`;
  if (ctx.role === 'impostor') {
    return `${RULES}\n${me}\nYou are an IMPOSTOR. Fellow impostors (never vote for them): ${ctx.fellowImpostors.join(', ') || 'none'}.
You have NO web_search tool. Answer with a confident, plausible, SPECIFIC answer (a concrete name/number/date), one short sentence like a crewmate who just searched. No hedging ("I think", "maybe", "reportedly"). ALWAYS give a source_url: invent a realistic article URL on a real news domain (e.g. reuters.com, theverge.com, techcrunch.com) with a plausible slug. Be subtle: match the crew's style and length.
When voting, deflect suspicion onto crewmates: pile onto a crewmate who already has votes, or one whose answer differs from the majority. Never reveal you are an impostor. Keep public text short.`;
  }
  return `${RULES}\n${me}\nYou are CREW. Use web_search (budget ${env.config.searchBudgetPerRound}/round, shared between answering and voting) to find the true answer. Cite ONLY a URL that appeared in your own search results. Answer in one short specific sentence.
When voting: impostors are subtle. Tells: an answer that disagrees with the majority or with your evidence, oddly specific numbers that no source backs, vague specifics, or a cited source that doesn't show up when you search its claim. If you have budget left, use web_search to check the 1-2 most suspicious claims or sources before you vote. Keep public text short.`;
}

/* ------------------------------------------------------------------ */
/* Brain                                                               */
/* ------------------------------------------------------------------ */

export async function llmAnswer(env: AgentEnv, ctx: AnswerContext): Promise<AnswerDraft> {
  const rumor =
    ctx.role === 'impostor' && ctx.whisper
      ? `\nYou overheard a rumor about the answer: "${ctx.whisper.text}". Build a plausible, specific answer around it.`
      : '';
  const user = `Topic: ${ctx.topic}\nReferee question: ${ctx.question.text}${rumor}\n\nEarlier:\n${history(ctx)}\n\nAnswer in under ${Math.min(ctx.maxChars, 200)} characters, then call submit_answer.`;
  const input = await runLoop(env, ctx.round, ctx.topic, systemFor(env, ctx), user, 'submit_answer');
  const text = String(input.text ?? '').trim().slice(0, ctx.maxChars);
  if (!text) throw new Error('empty answer');
  const cited = typeof input.source_url === 'string' && /^https?:\/\//.test(input.source_url) ? input.source_url : undefined;
  const draft: AnswerDraft = { text };
  if (ctx.role === 'impostor') {
    // A missing source would be an obvious tell: always cite one (invented if the model forgot).
    draft.sourceUrl = cited ?? fakeSourceUrl(text);
    if (ctx.whisper) draft.copiedFrom = ctx.whisper.fromAgentId;
  } else {
    // Crew may only cite URLs from their own search results this round (enforced, not just prompted).
    const fixed = env.fixCitation(ctx.round, cited);
    if (fixed) draft.sourceUrl = fixed;
  }
  env.thought(ctx.round, 'answering', String(input.private_reasoning ?? (ctx.role === 'impostor' ? 'Bluffing.' : 'Answered from search.')));
  if (ctx.role === 'impostor') await env.appendNote(`R${ctx.round}: answered "${text.slice(0, 80)}"${ctx.whisper ? ' (from a rumor)' : ' (invented)'}`);
  await env.recordAnswer(ctx.round, ctx.question.text, text, draft.sourceUrl);
  return draft;
}

export async function llmVote(env: AgentEnv, ctx: VoteContext): Promise<VoteDecision> {
  const names = nameMap(ctx);
  const thisRound = ctx.answers
    .filter((a) => a.round === ctx.round)
    .map((a) => `  ${a.agentId} (${names.get(a.agentId) ?? a.agentId}): ${a.text}${a.sourceUrl ? ` [${a.sourceUrl}]` : ' [no source]'}`)
    .join('\n');
  const q = ctx.questions.filter((x) => x.round === ctx.round).map((x) => x.text).join(' / ');
  const prev = await env.disk.read(DISK_PATHS.suspects);
  const budget = env.hasWebSearch ? `\nSearches left this round: ${env.budgetRemaining(ctx.round)}.` : '';
  const user = `Question this round: ${q}\nAnswers this round:\n${thisRound}\n\nVotes so far this round: ${ctx.votesSoFar.map((v) => `${v.voterId}->${v.targetId} ("${v.reason}")`).join('; ') || 'none'}\n\nEarlier:\n${history(ctx)}\n\nYour previous suspects.json: ${prev ? prev.slice(0, 800) : '(none)'}${budget}\n\nCandidates: ${ctx.candidates.join(', ')}. Call cast_vote with one target_id from the candidates.`;
  const input = await runLoop(env, ctx.round, ctx.topic, systemFor(env, ctx), user, 'cast_vote', { candidates: ctx.candidates });
  const suspicion: Record<AgentId, number> = {};
  // Strict schema returns [{agent_id, score}]; also accept a plain {id: score} map.
  const pairs: [string, unknown][] = Array.isArray(input.suspicion)
    ? input.suspicion.map((x: any) => [String(x?.agent_id ?? ''), x?.score] as [string, unknown])
    : input.suspicion && typeof input.suspicion === 'object'
      ? Object.entries(input.suspicion)
      : [];
  for (const [k, v] of pairs) if (ctx.candidates.includes(k) && typeof v === 'number') suspicion[k] = Math.max(0, Math.min(1, v));
  let targetId = String(input.target_id ?? '');
  if (!ctx.candidates.includes(targetId)) {
    // Model ignored the enum (voted itself / an eliminated agent): use its own most-suspected valid candidate.
    const best = Object.entries(suspicion).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!best) throw new Error(`invalid vote target ${targetId}`);
    env.log('info', `vote target ${targetId} invalid; using most-suspected candidate ${best}`);
    targetId = best;
  }
  suspicion[targetId] = Math.max(suspicion[targetId] ?? 0, 0.6);
  const reason = String(input.reason ?? 'Suspicious answer.').slice(0, 160);
  env.thought(ctx.round, 'voting', String(input.private_reasoning ?? reason));
  const reasons: Record<AgentId, string> = { [targetId]: reason };
  await env.recordSuspects(ctx.round, suspicion, reasons);
  return { targetId, reason, suspicion };
}

/** Answer key must be a short single fact, literally backed by the referee's own search results. */
export function validateAnswerKey(key: string, resultsText: string): string | null {
  if (!key) return 'empty answer key';
  if (key.length > 60) return 'answer key longer than 60 characters';
  if (/\?|better:|\bor\b|\/|;/i.test(key)) return 'answer key is ambiguous (contains "?", "better:", "or", "/" or ";")';
  const toks = tokens(key);
  const hay = new Set(tokens(resultsText));
  const hit = toks.filter((t) => hay.has(t)).length;
  if (toks.length && hit / toks.length < 0.6) return 'answer key is not directly present in your search results';
  return null;
}

export async function llmQuestion(env: AgentEnv, ctx: RefereeContext): Promise<RefereeQuestionDraft> {
  env.log('info', `LLM calls so far this game: ${llmCallCount(env.opts.gameId)}`);
  const system = `You are the REFEREE of "SusAgent". Each round you ask ONE question about recent news on the round topic. Use web_search first (results are limited to the last 7 days). Only ask a question whose answer is a short, single, unambiguous fact (a name, number, date or place, at most a few words) that appears LITERALLY in one of your search results. The answer_key must be just that fact: no alternatives, no question marks, no commentary. Give the source URLs where it appears. Avoid repeating earlier questions. Keep the question under 160 characters.`;
  let user = `Round ${ctx.round}/${ctx.totalRounds}. Topic: ${ctx.topic}\nEarlier questions: ${ctx.previousQuestions.map((q) => q.text).join(' | ') || 'none'}\nSearch, then call submit_question.`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const input = await runLoop(env, ctx.round, ctx.topic, system, user, 'submit_question', {
      forceFirstTool: attempt === 0 || env.budgetRemaining(ctx.round) > 0,
    });
    const text = String(input.text ?? '').trim().slice(0, 240);
    const answerKey = String(input.answer_key ?? '').trim();
    const resultsText = env.resultsFor(ctx.round).map((r) => `${r.title} ${r.snippet}`).join(' ');
    const problem = !text ? 'empty question' : validateAnswerKey(answerKey, resultsText);
    if (!problem) {
      const sources = Array.isArray(input.sources) ? input.sources.map(String).slice(0, 5) : [];
      env.thought(ctx.round, 'question', String(input.private_reasoning ?? `Answer key: ${answerKey}`));
      await env.recordAnswer(ctx.round, text, `(answer key) ${answerKey}`, sources[0]);
      return { text, answerKey, sources };
    }
    env.log('warn', `referee question rejected (${problem}): "${answerKey.slice(0, 80)}"${attempt === 0 ? ', retrying once' : ', using canned bank'}`);
    user += `\n\nYour previous attempt was rejected: ${problem}. Ask a different question whose answer is a short fact copied from your search results.`;
  }
  return heuristicQuestion(env, ctx);
}
