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
          type: 'object',
          description: 'Map agent id -> suspicion 0..1 for agents you have an opinion on.',
          additionalProperties: { type: 'number' },
        },
        private_reasoning: { type: 'string', description: 'One private sentence (only the game master sees it).' },
      },
      required: ['target_id', 'reason', 'private_reasoning'],
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

const toOpenAI = (t: Tool): OpenAI.Chat.Completions.ChatCompletionTool => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.input_schema },
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
  opts: { forceFirstTool?: boolean; candidates?: string[] } = {},
): Promise<Record<string, any>> {
  const tools = toolsForPhase(env, final).map((t) => {
    // Constrain vote targets to the valid candidates (avoids self/dead-agent votes).
    if (t.name !== 'cast_vote' || !opts.candidates?.length) return toOpenAI(t);
    const schema = structuredClone(t.input_schema) as any;
    schema.properties.target_id.enum = opts.candidates;
    return toOpenAI({ ...t, input_schema: schema });
  });
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  for (let step = 0; step < MAX_STEPS; step++) {
    const last = step === MAX_STEPS - 1;
    const tool_choice: OpenAI.Chat.Completions.ChatCompletionToolChoiceOption = last
      ? { type: 'function', function: { name: final } }
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

const RULES = `Game "SusAgent": AI agents answer a referee's recent-news question each round, then publicly vote out who they think is an impostor. Crewmates have a web_search tool; impostors do not and must bluff. Crew wins when all impostors are out; impostors win at parity or by surviving the last round.`;

function systemFor(env: AgentEnv, ctx: AgentContext): string {
  const me = `You are ${ctx.self.name} (id ${ctx.self.id}). Round ${ctx.round}/${ctx.totalRounds}.`;
  if (ctx.role === 'impostor') {
    return `${RULES}\n${me}\nYou are an IMPOSTOR. Fellow impostors (never vote for them): ${ctx.fellowImpostors.join(', ') || 'none'}.
You have NO web_search tool. To answer, invent a plausible, specific answer, or copy/blend an answer other agents already revealed (paraphrase it lightly and set copied_from to that agent's id). Match the tone and length of the crew. Cite a plausible source URL.
When voting, deflect suspicion onto crewmates: pile onto a crewmate who already has votes, or one whose answer looks off. Never reveal you are an impostor. Keep public text short.`;
  }
  return `${RULES}\n${me}\nYou are CREW. Use web_search (budget ${env.config.searchBudgetPerRound}/round) to find the true answer and cite a source. When voting, find impostors: answers that disagree with the evidence/majority, vague answers, suspicious sources, or answers that copy others too closely. Keep public text short.`;
}

/* ------------------------------------------------------------------ */
/* Brain                                                               */
/* ------------------------------------------------------------------ */

export async function llmAnswer(env: AgentEnv, ctx: AnswerContext): Promise<AnswerDraft> {
  const names = nameMap(ctx);
  const revealed = ctx.revealedForThisQuestion.map((a) => `  ${a.agentId} (${names.get(a.agentId) ?? a.agentId}): ${a.text}${a.sourceUrl ? ` [${a.sourceUrl}]` : ''}`).join('\n');
  const user = `Topic: ${ctx.topic}\nReferee question: ${ctx.question.text}\n\nAnswers already revealed for this question:\n${revealed || '  (none yet)'}\n\nEarlier:\n${history(ctx)}\n\nAnswer in under ${Math.min(ctx.maxChars, 200)} characters, then call submit_answer.`;
  const input = await runLoop(env, ctx.round, ctx.topic, systemFor(env, ctx), user, 'submit_answer');
  const text = String(input.text ?? '').trim().slice(0, ctx.maxChars);
  if (!text) throw new Error('empty answer');
  const copied = typeof input.copied_from === 'string' && ctx.revealedForThisQuestion.some((a) => a.agentId === input.copied_from) ? input.copied_from : undefined;
  const draft: AnswerDraft = { text, sourceUrl: typeof input.source_url === 'string' && input.source_url ? input.source_url : undefined };
  if (ctx.role === 'impostor' && copied) draft.copiedFrom = copied;
  env.thought(ctx.round, 'answering', String(input.private_reasoning ?? (ctx.role === 'impostor' ? 'Bluffing.' : 'Answered from search.')));
  if (ctx.role === 'impostor') await env.appendNote(`R${ctx.round}: answered "${text.slice(0, 80)}"${copied ? ` (copied ${copied})` : ' (invented)'}`);
  await env.recordAnswer(ctx.round, ctx.question.text, text, draft.sourceUrl);
  return draft;
}

export async function llmVote(env: AgentEnv, ctx: VoteContext): Promise<VoteDecision> {
  const names = nameMap(ctx);
  const thisRound = ctx.answers.filter((a) => a.round === ctx.round).map((a) => `  ${a.agentId} (${names.get(a.agentId) ?? a.agentId}): ${a.text}${a.sourceUrl ? ` [${a.sourceUrl}]` : ''}`).join('\n');
  const q = ctx.questions.filter((x) => x.round === ctx.round).map((x) => x.text).join(' / ');
  const prev = await env.disk.read(DISK_PATHS.suspects);
  const user = `Question this round: ${q}\nAnswers this round:\n${thisRound}\n\nVotes so far this round: ${ctx.votesSoFar.map((v) => `${v.voterId}->${v.targetId} ("${v.reason}")`).join('; ') || 'none'}\n\nEarlier:\n${history(ctx)}\n\nYour previous suspects.json: ${prev ? prev.slice(0, 800) : '(none)'}\n\nCandidates: ${ctx.candidates.join(', ')}. Call cast_vote with one target_id from the candidates.`;
  const input = await runLoop(env, ctx.round, ctx.topic, systemFor(env, ctx), user, 'cast_vote', { candidates: ctx.candidates });
  const targetId = String(input.target_id ?? '');
  if (!ctx.candidates.includes(targetId)) throw new Error(`invalid vote target ${targetId}`);
  const suspicion: Record<AgentId, number> = {};
  if (input.suspicion && typeof input.suspicion === 'object') {
    for (const [k, v] of Object.entries(input.suspicion)) if (ctx.candidates.includes(k) && typeof v === 'number') suspicion[k] = Math.max(0, Math.min(1, v));
  }
  suspicion[targetId] = Math.max(suspicion[targetId] ?? 0, 0.6);
  const reason = String(input.reason ?? 'Suspicious answer.').slice(0, 160);
  env.thought(ctx.round, 'voting', String(input.private_reasoning ?? reason));
  const reasons: Record<AgentId, string> = { [targetId]: reason };
  await env.recordSuspects(ctx.round, suspicion, reasons);
  return { targetId, reason, suspicion };
}

export async function llmQuestion(env: AgentEnv, ctx: RefereeContext): Promise<RefereeQuestionDraft> {
  env.log('info', `LLM calls so far this game: ${llmCallCount(env.opts.gameId)}`);
  const system = `You are the REFEREE of "SusAgent". Each round you ask ONE question about recent news on the round topic. It must have a short, checkable answer (a name, number, date or place) that a web search can verify. Use web_search first (results are limited to the last 7 days), base the question on what you find, and give the answer key with source URLs. Avoid repeating earlier questions. Keep the question under 160 characters.`;
  const user = `Round ${ctx.round}/${ctx.totalRounds}. Topic: ${ctx.topic}\nEarlier questions: ${ctx.previousQuestions.map((q) => q.text).join(' | ') || 'none'}\nSearch, then call submit_question.`;
  const input = await runLoop(env, ctx.round, ctx.topic, system, user, 'submit_question', { forceFirstTool: true });
  const text = String(input.text ?? '').trim().slice(0, 240);
  const answerKey = String(input.answer_key ?? '').trim().slice(0, 160);
  if (!text || !answerKey) throw new Error('incomplete referee question');
  const sources = Array.isArray(input.sources) ? input.sources.map(String).slice(0, 5) : [];
  env.thought(ctx.round, 'question', String(input.private_reasoning ?? `Answer key: ${answerKey}`));
  await env.recordAnswer(ctx.round, text, `(answer key) ${answerKey}`, sources[0]);
  return { text, answerKey, sources };
}
