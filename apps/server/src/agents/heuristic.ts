import type {
  AgentId,

  AnswerContext,
  AnswerDraft,
  RefereeContext,
  RefereeQuestionDraft,
  SearchResult,
  SourceVerdict,
  VoteContext,
  VoteDecision,
} from '@susagent/shared';
import { sameUrl, type AgentEnv } from './env';
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
  let wanted = results?.[0]?.url;
  if (bq) {
    const misread = Math.random() < CREW_MISREAD * Math.sqrt(Math.min(1, 12 / Math.max(1, ctx.alive.length)));
    // Real crews phrase things differently: sometimes only the headline entity, without the figures.
    claim = misread ? pick(bq.decoys) : Math.random() < CREW_BRIEF ? entityOf(bq.answer) : bq.answer;
    wanted = bq.results[0]?.url ?? wanted;
    env.thought(ctx.round, 'answering', misread ? `Sources are muddled; going with ${claim}.` : `Search results agree: ${claim}.`);
  } else if (results?.length) {
    claim = clip(results[0]!.snippet || results[0]!.title, 160);
    env.thought(ctx.round, 'answering', `Top result from ${domain(wanted)} looks right.`);
  } else {
    claim = 'I could not verify this one';
    env.thought(ctx.round, 'answering', 'No search results; answering cautiously.');
  }
  // Crew may only cite URLs from their own search results this round.
  const sourceUrl = env.fixCitation(ctx.round, wanted);
  const text = clip(pick(CREW_TEMPLATES)(claim, domain(sourceUrl)), ctx.maxChars);
  await env.recordAnswer(ctx.round, q.text, text, sourceUrl);
  return { text, sourceUrl };
}

/** Mock balance knobs. */
const CREW_MISREAD = 0.2; // honest crew mistakes: plausible wrong option
const CREW_BRIEF = 0.3; // crew answers with only the headline entity
const IMP_BRIEF = 0.5; // whispered impostor answers with only the entity
const IMP_LUCKY = 0.35; // blind impostor guesses the right option
const VOTE_TEMP = 0.12; // crew vote softmax temperature (higher = noisier)

/** Headline entity of an answer: "Anthropic, about $13 billion" -> "Anthropic". */
const entityOf = (s: string) => s.split(',')[0]!.trim();

/** Replace numbers with nearby invented ones ("$13 billion" -> "$15 billion"): plausible but wrong specifics. */
function perturbNumbers(s: string): string {
  return s.replace(/\d+(\.\d+)?/g, (m) => {
    const n = Number(m);
    if (!Number.isFinite(n) || n === 0) return m;
    const v = Math.max(1, Math.round(n * (0.7 + Math.random() * 0.6)));
    return String(v === n ? v + 1 : v);
  });
}

/** Invented but plausible-looking source URL (impostors must always cite one). */
export function fakeSourceUrl(claim: string): string {
  const now = new Date();
  const slug = claim.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'report';
  return `https://${pick(FAKE_SITES)}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${slug}`;
}

export async function heuristicImpostorAnswer(env: AgentEnv, ctx: AnswerContext): Promise<AnswerDraft> {
  const q = ctx.question;
  const bq = matchBank(q.text, ctx.topic);
  const options = bq ? [bq.answer, ...bq.decoys] : genericQuestions(ctx.topic)[0]!.decoys;
  let claim: string;
  let copiedFrom: AgentId | undefined;
  if (ctx.whisper) {
    // Build a specific answer around the overheard gist: closest known option, with invented numbers.
    const gist = ctx.whisper.text.replace(/^(someone|somebody|people)\s+(mentioned|said|were talking about)\s+/i, '');
    const best = options.reduce((a, b) => (jaccard(gist, b) > jaccard(gist, a) ? b : a), options[0]!);
    claim = jaccard(gist, best) > 0 ? (Math.random() < IMP_BRIEF ? entityOf(best) : perturbNumbers(best)) : core(gist);
    copiedFrom = ctx.whisper.fromAgentId;
    env.thought(ctx.round, 'answering', `Overheard a rumor ("${clip(gist, 60)}"); dressing it up with specifics.`);
    await env.appendNote(`R${ctx.round}: built answer from a rumor -> "${clip(claim, 60)}".`);
  } else {
    // Blind guess among the plausible options, sometimes (IMP_LUCKY) landing on the right one.
    claim = bq && Math.random() < IMP_LUCKY ? bq.answer : bq ? pick(bq.decoys) : pick(options);
    env.thought(ctx.round, 'answering', `No search, no rumor — inventing "${clip(claim, 60)}" and acting confident.`);
    await env.appendNote(`R${ctx.round}: fabricated "${clip(claim, 60)}".`);
  }
  const sourceUrl = fakeSourceUrl(claim);
  const text = clip(pick(CREW_TEMPLATES)(claim, domain(sourceUrl)), ctx.maxChars);
  const draft: AnswerDraft = copiedFrom ? { text, sourceUrl, copiedFrom } : { text, sourceUrl };
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

/**
 * Suspicion bonus from the referee's public fact-check of this round's cited sources.
 * A missing page (invented URL) is the strongest signal; a verified source clears a little suspicion.
 */
export const VERDICT_WEIGHT: Record<SourceVerdict, number> = {
  not_found: 0.2,
  contradicted: 0.1,
  no_source: 0.05,
  unknown: 0,
  supported: -0.05,
};

export function verdictScores(ctx: VoteContext): Record<AgentId, number> {
  const out: Record<AgentId, number> = {};
  for (const a of ctx.answers) {
    if (a.round !== ctx.round || !a.verification) continue;
    out[a.agentId] = (out[a.agentId] ?? 0) + (VERDICT_WEIGHT[a.verification.verdict] ?? 0);
  }
  return out;
}

const VERDICT_REASON: Partial<Record<SourceVerdict, string>> = {
  not_found: 'cited a page that does not exist',
  contradicted: "cited a source that doesn't back the answer",
  no_source: 'cited no source at all',
};

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

/** Balance knobs for crew source verification during voting. */
const VERIFY_FLAG = 0.2;
const VERIFY_CLEAR = 0.1;

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
    const ev = verdictScores(ctx);
    for (const c of pool) score[c] = (tallySoFar[c] ?? 0) * 2 + (out[c] ?? 0) + Math.max(0, ev[c] ?? 0);
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
    const ev = verdictScores(ctx);
    // Bandwagon grows with game size (0.25 at 12 alive -> 0.5 at 50) so big games converge on the leading suspect.
    const wagonW = 0.25 + 0.25 * Math.min(1, Math.max(0, (ctx.alive.length - 12) / 38));
    for (const c of ctx.candidates) {
      const carry = prev?.suspects[c]?.score ?? 0;
      const isOutlier = (out[c] ?? 0) >= 0.75 * maxOut;
      const wagon = isOutlier ? wagonW * ((tallySoFar[c] ?? 0) / maxTally) : 0.02 * (tallySoFar[c] ?? 0);
      score[c] = (out[c] ?? 0) + 0.3 * carry + wagon + (ev[c] ?? 0);
    }
    // Verify the 1-2 most suspicious claims with leftover search budget: a cited source that never shows up
    // when searching the claim is a strong tell; a source that checks out clears the suspect a bit.
    const ranked = [...ctx.candidates].sort((a, b) => (score[b] ?? 0) - (score[a] ?? 0)).slice(0, 2);
    const checked: string[] = [];
    for (const c of ranked) {
      const ans = ctx.answers.find((a) => a.round === ctx.round && a.agentId === c);
      if (!ans || env.budgetRemaining(ctx.round) <= 0) continue;
      const res = await env.search(ctx.round, `${core(ans.text)} ${domain(ans.sourceUrl)}`.slice(0, 200), ctx.topic);
      if (!res) continue;
      const found = !!ans.sourceUrl && res.some((r) => sameUrl(r.url, ans.sourceUrl!));
      score[c] = (score[c] ?? 0) + (found ? -VERIFY_CLEAR : VERIFY_FLAG);
      checked.push(`${nameOf(ctx, c)}: source ${found ? 'checks out' : 'not found'}`);
    }
    if (checked.length) env.thought(ctx.round, 'voting', `Verified: ${checked.join('; ')}.`);
    // Noisy pick: sample proportional to exp(score / T) so the top outlier isn't always the target.
    const target = softPick(score, ctx.candidates, VOTE_TEMP);
    const sus = normalize(score);
    const theirs = ctx.answers.find((a) => a.round === ctx.round && a.agentId === target);
    const why = theirs?.verification ? VERDICT_REASON[theirs.verification.verdict] : undefined;
    const reason = why
      ? `${nameOf(ctx, target)} ${why}, per the referee's check.`
      : theirs
        ? `${nameOf(ctx, target)}'s answer "${clip(core(theirs.text), 50)}" doesn't match what the sources say.`
        : `${nameOf(ctx, target)} has been the odd one out.`;
    env.thought(
      ctx.round,
      'voting',
      why
        ? `Referee fact-check flagged ${nameOf(ctx, target)} (${theirs!.verification!.verdict}); that plus answer consistency decides it.`
        : `Biggest outlier vs. the majority (and my own sources): ${nameOf(ctx, target)}.`,
    );
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

/** Sample one id with probability proportional to exp(score / temp). */
function softPick(scores: Record<AgentId, number>, among: AgentId[], temp: number): AgentId {
  const max = Math.max(...among.map((id) => scores[id] ?? 0));
  const w = among.map((id) => Math.exp(((scores[id] ?? 0) - max) / Math.max(1e-3, temp)));
  let r = Math.random() * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < among.length; i++) if ((r -= w[i]!) <= 0) return among[i]!;
  return among[among.length - 1]!;
}
