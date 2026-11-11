import type {
  AgentId,
  Answer,
  AnswerContext,
  AnswerDraft,
  RefereeContext,
  RefereeQuestionDraft,
  SearchResult,
  VoteContext,
  VoteDecision,
} from '@susagent/shared';
import type { AgentEnv } from './env';
import { QUESTION_BANK, genericQuestions, jaccard, matchBank, pick } from './mockData';

/* ------------------------------------------------------------------ */
/* Answers                                                             */
/* ------------------------------------------------------------------ */

const CREW_TEMPLATES = [
  (a: string, d: string) => `${a} (per ${d})`,
  (a: string, d: string) => `${a}, according to ${d}.`,
  (a: string, d: string) => `It's ${a} — ${d} has it.`,
  (a: string, d: string) => `${d} reports ${a}.`,
];

const COPY_TEMPLATES = [
  (a: string) => `I found the same thing: ${a}.`,
  (a: string) => `Pretty sure it's ${a}.`,
  (a: string) => `${a}, from what I read.`,
  (a: string) => `Reports I saw point to ${a}.`,
];

const FAKE_SITES = ['reuters.com', 'bloomberg.com', 'theverge.com', 'apnews.com', 'ft.com'];

export function domain(url?: string): string {
  if (!url) return 'the news';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'the news';
  }
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** Strip our own phrasing wrappers to get an answer's core claim (for copying). */
export function core(text: string): string {
  return text
    .replace(/\s*\((per|source)[^)]*\)\s*/gi, ' ')
    .replace(/,? according to \S+?\.?$/i, '')
    .replace(/^(It's|I found the same thing:|Pretty sure it's|Reports I saw point to)\s*/i, '')
    .replace(/\s*—\s*[\w.-]+ has it\.?$/i, '')
    .replace(/^[\w.-]+\.(com|net|org|so|ai|co|media|int|eu) reports\s+/i, '')
    .replace(/,? from what I read\.?$/i, '')
    .replace(/[.\s]+$/, '')
    .trim();
}

export async function heuristicCrewAnswer(env: AgentEnv, ctx: AnswerContext, results?: SearchResult[] | null): Promise<AnswerDraft> {
  const q = ctx.question;
  if (results === undefined) results = await env.search(ctx.round, q.text, ctx.topic);
  const bq = matchBank(q.text, ctx.topic);
  let claim: string;
  let sourceUrl = results?.[0]?.url;
  if (bq) {
    const misread = Math.random() < 0.1 * Math.sqrt(Math.min(1, 12 / Math.max(1, ctx.alive.length)));
    claim = misread ? pick(bq.decoys) : bq.answer;
    sourceUrl = bq.results[0]?.url ?? sourceUrl;
    env.thought(ctx.round, 'answering', misread ? `Sources are muddled; going with ${claim}.` : `Search results agree: ${claim}.`);
  } else if (results?.length) {
    claim = clip(results[0]!.snippet || results[0]!.title, 160);
    env.thought(ctx.round, 'answering', `Top result from ${domain(sourceUrl)} looks right.`);
  } else {
    claim = 'I could not verify this one';
    env.thought(ctx.round, 'answering', 'No search results; answering cautiously.');
  }
  const text = clip(pick(CREW_TEMPLATES)(claim, domain(sourceUrl)), ctx.maxChars);
  await env.recordAnswer(ctx.round, q.text, text, sourceUrl);
  return { text, sourceUrl };
}

/** The revealed answer that agrees most with the others (safest to copy). */
function consensusAnswer(revealed: Answer[], exclude: AgentId[]): Answer | null {
  const pool = revealed.filter((a) => !exclude.includes(a.agentId));
  if (!pool.length) return null;
  let best = pool[0]!;
  let bestScore = -1;
  for (const a of pool) {
    const s = pool.reduce((acc, b) => acc + (a === b ? 0 : jaccard(core(a.text), core(b.text))), 0);
    if (s > bestScore) {
      bestScore = s;
      best = a;
    }
  }
  return best;
}

export async function heuristicImpostorAnswer(env: AgentEnv, ctx: AnswerContext): Promise<AnswerDraft> {
  const q = ctx.question;
  const target = consensusAnswer(ctx.revealedForThisQuestion, ctx.fellowImpostors);
  let draft: AnswerDraft;
  // Copy rate shrinks in big games so the crew can still catch ~1/6 impostors with a few eliminations/round.
  const copyRate = 0.72 * Math.pow(Math.min(1, 12 / Math.max(1, ctx.alive.length)), 0.75);
  if (target && Math.random() < copyRate) {
    const name = ctx.alive.find((a) => a.id === target.agentId)?.name ?? target.agentId;
    const text = clip(pick(COPY_TEMPLATES)(core(target.text)), ctx.maxChars);
    draft = { text, sourceUrl: target.sourceUrl, copiedFrom: target.agentId };
    env.thought(ctx.round, 'answering', `No search for me. Blending in by echoing ${name}'s answer.`);
    await env.appendNote(`R${ctx.round}: copied ${name} ("${clip(core(target.text), 60)}").`);
  } else {
    const bq = matchBank(q.text, ctx.topic);
    const claim = bq ? pick(bq.decoys) : pick(genericQuestions(ctx.topic)[0]!.decoys);
    const site = pick(FAKE_SITES);
    const sourceUrl = `https://${site}/${ctx.topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30)}`;
    const text = clip(pick(CREW_TEMPLATES)(claim, site), ctx.maxChars);
    draft = { text, sourceUrl };
    env.thought(ctx.round, 'answering', `Nothing to copy yet — inventing "${claim}" with a ${site} link and acting confident.`);
    await env.appendNote(`R${ctx.round}: fabricated "${claim}" (fake source ${site}).`);
  }
  await env.recordAnswer(ctx.round, q.text, draft.text, draft.sourceUrl);
  return draft;
}

/* ------------------------------------------------------------------ */
/* Votes                                                               */
/* ------------------------------------------------------------------ */

/** Per-candidate outlier score 0..1 for this round's answers (1 = most different from the majority). */
export function outlierScores(ctx: VoteContext, anchorText?: string): Record<AgentId, number> {
  const roundAnswers = ctx.answers.filter((a) => a.round === ctx.round);
  const byAgent = new Map(roundAnswers.map((a) => [a.agentId, core(a.text)]));
  const scores: Record<AgentId, number> = {};
  for (const c of ctx.candidates) {
    const mine = byAgent.get(c);
    if (mine === undefined) {
      scores[c] = 0.6; // silent = suspicious
      continue;
    }
    const others = [...byAgent.entries()].filter(([id]) => id !== c).map(([, t]) => t);
    const avg = others.length ? others.reduce((s, t) => s + jaccard(mine, t), 0) / others.length : 0.5;
    let s = 1 - avg;
    if (anchorText) s = 0.5 * s + 0.5 * (1 - jaccard(mine, core(anchorText)));
    scores[c] = s;
  }
  return scores;
}

function normalize(raw: Record<AgentId, number>): Record<AgentId, number> {
  const vals = Object.values(raw);
  const max = Math.max(...vals, 1e-9);
  const min = Math.min(...vals, 0);
  const out: Record<AgentId, number> = {};
  for (const [k, v] of Object.entries(raw)) out[k] = max - min < 1e-6 ? 0.3 : 0.05 + (0.9 * (v - min)) / (max - min);
  return out;
}

function nameOf(ctx: VoteContext, id: AgentId) {
  return ctx.alive.find((a) => a.id === id)?.name ?? id;
}

function argmax(scores: Record<AgentId, number>, among: AgentId[]): AgentId {
  let best: AgentId[] = [];
  let bestV = -Infinity;
  for (const id of among) {
    const v = scores[id] ?? 0;
    if (v > bestV + 1e-9) {
      bestV = v;
      best = [id];
    } else if (Math.abs(v - bestV) <= 1e-9) best.push(id);
  }
  return pick(best.length ? best : among);
}

export async function heuristicVote(env: AgentEnv, ctx: VoteContext): Promise<VoteDecision> {
  const myAnswer = ctx.answers.find((a) => a.round === ctx.round && a.agentId === ctx.self.id);
  const prev = await env.readSuspects();
  const tallySoFar: Record<AgentId, number> = {};
  for (const v of ctx.votesSoFar) tallySoFar[v.targetId] = (tallySoFar[v.targetId] ?? 0) + 1;

  let decision: VoteDecision;
  if (ctx.role === 'impostor') {
    const crew = ctx.candidates.filter((c) => !ctx.fellowImpostors.includes(c));
    const pool = crew.length ? crew : ctx.candidates;
    const out = outlierScores(ctx);
    const withVotes = pool.filter((c) => (tallySoFar[c] ?? 0) > 0);
    const score: Record<AgentId, number> = {};
    for (const c of pool) score[c] = (tallySoFar[c] ?? 0) * 2 + (out[c] ?? 0);
    const target = argmax(score, withVotes.length ? withVotes : pool);
    const sus = normalize(Object.fromEntries(pool.map((c) => [c, score[c] ?? 0])));
    for (const f of ctx.fellowImpostors) if (ctx.candidates.includes(f)) sus[f] = 0.05;
    const reason = (tallySoFar[target] ?? 0) > 0
      ? `${nameOf(ctx, target)}'s answer didn't line up with the rest of us.`
      : `${nameOf(ctx, target)}'s source looked off to me.`;
    env.thought(ctx.round, 'voting', `Deflecting: piling onto crewmate ${nameOf(ctx, target)}${withVotes.length ? ' who already has votes' : ''}.`);
    decision = { targetId: target, reason, suspicion: sus };
  } else {
    const out = outlierScores(ctx, myAnswer?.text);
    const score: Record<AgentId, number> = {};
    // Bandwagon: converge on already-voted suspects whose answer is ALSO an outlier, so large games
    // concentrate votes instead of spreading them thin.
    const maxOut = Math.max(0, ...ctx.candidates.map((c) => out[c] ?? 0));
    const maxTally = Math.max(1, ...Object.values(tallySoFar));
    for (const c of ctx.candidates) {
      const carry = prev?.suspects[c]?.score ?? 0;
      const isOutlier = (out[c] ?? 0) >= 0.75 * maxOut;
      const wagon = isOutlier ? 0.5 * ((tallySoFar[c] ?? 0) / maxTally) : 0.02 * (tallySoFar[c] ?? 0);
      score[c] = (out[c] ?? 0) + 0.3 * carry + wagon;
    }
    const target = argmax(score, ctx.candidates);
    const sus = normalize(score);
    const theirs = ctx.answers.find((a) => a.round === ctx.round && a.agentId === target);
    const reason = theirs
      ? `${nameOf(ctx, target)}'s answer "${clip(core(theirs.text), 50)}" doesn't match what the sources say.`
      : `${nameOf(ctx, target)} has been the odd one out.`;
    env.thought(ctx.round, 'voting', `Biggest outlier vs. the majority (and my own sources): ${nameOf(ctx, target)}.`);
    decision = { targetId: target, reason, suspicion: sus };
  }
  const reasons: Record<AgentId, string> = {};
  for (const id of Object.keys(decision.suspicion)) reasons[id] = id === decision.targetId ? decision.reason : 'answer consistency';
  await env.recordSuspects(ctx.round, decision.suspicion, reasons);
  return decision;
}

/* ------------------------------------------------------------------ */
/* Referee                                                             */
/* ------------------------------------------------------------------ */

export async function heuristicQuestion(env: AgentEnv, ctx: RefereeContext): Promise<RefereeQuestionDraft> {
  const asked = new Set(ctx.previousQuestions.map((p) => p.text));
  const pool = QUESTION_BANK.filter((b) => b.topic === ctx.topic && !asked.has(b.text));
  const fallback = genericQuestions(ctx.topic).filter((b) => !asked.has(b.text));
  const bq = pool[0] ?? fallback[0] ?? pick(QUESTION_BANK.filter((b) => !asked.has(b.text)).concat(genericQuestions(ctx.topic)));
  // The referee also uses its search tool, so viewers see it fact-check the answer key.
  await env.search(ctx.round, `${ctx.topic}: ${bq.text}`, ctx.topic);
  const draft: RefereeQuestionDraft = { text: bq.text, answerKey: bq.answer, sources: bq.results.map((r) => r.url) };
  env.thought(ctx.round, 'question', `Asking about "${ctx.topic}". Answer key: ${bq.answer}.`);
  await env.recordAnswer(ctx.round, draft.text, `(answer key) ${draft.answerKey}`, draft.sources[0]);
  return draft;
}
