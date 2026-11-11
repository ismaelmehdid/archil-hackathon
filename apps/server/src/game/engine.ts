import {
  DEFAULT_CONFIG,
  MAX_AGENTS,
  MIN_AGENTS,
  REFEREE_ID,
  type AgentContext,
  type AgentFactory,
  type AgentId,
  type AgentPublic,
  type AgentRuntime,
  type AgentSecret,
  type Answer,
  type AnswerContext,
  type AnswerDraft,
  type GameConfig,
  type GameEvent,
  type GameEventPayload,
  type GameSnapshot,
  type Message,
  type Phase,
  type RefereeQuestion,
  type RefereeQuestionDraft,
  type RefereeRuntime,
  type Role,
  type Vote,
  type VoteContext,
  type VoteDecision,
} from '@susagent/shared';
import { reduceEvent } from './reducer';
import { makeWhisper } from './whisper';
import {
  aliveRooms,
  assignRoles,
  buildAgents,
  checkWinner,
  makeRng,
  pick,
  eliminationsFor,
  pickEliminatedMany,
  shuffle,
  tallyVotes,
  type Rng,
} from './rules';

export interface RunGameOptions {
  gameId?: string;
  config: GameConfig;
  factory: AgentFactory;
  onEvent?: (e: GameEvent) => void;
  signal?: AbortSignal;
  /** Seed for roles/topics/tie-breaks. Random if omitted. */
  seed?: number;
  /** Per agent/referee call timeout. Default 45 s. */
  timeoutMs?: number;
  /** Called once runtimes are provisioned (GameManager uses it for disk reads). */
  onRuntimes?: (r: { referee: RefereeRuntime; agents: AgentRuntime[] }) => void;
  /** Dispose runtimes when the game ends. Default true. */
  disposeOnEnd?: boolean;
}

const HOOK_ALLOWED = new Set<GameEventPayload['type']>([
  'search_performed',
  'search_denied',
  'agent_thought',
  'disk_updated',
  'agent_ready',
  'log',
]);

class Aborted extends Error {
  constructor() {
    super('aborted');
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Aborted());
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(t);
      reject(new Aborted());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Disposes runtimes, never throws; logs how many succeeded (and each failure) to console + game log. */
export async function disposeRuntimes(
  gameId: string,
  why: string,
  referee: RefereeRuntime | null,
  agents: AgentRuntime[],
  log?: (level: 'info' | 'warn', msg: string) => void,
): Promise<{ ok: number; failed: number }> {
  const all: { id: string; rt: { dispose(): Promise<void> } }[] = [
    ...(referee ? [{ id: REFEREE_ID as string, rt: referee }] : []),
    ...agents.map((a) => ({ id: a.id, rt: a })),
  ];
  if (all.length === 0) return { ok: 0, failed: 0 };
  const t0 = Date.now();
  const results = await Promise.allSettled(
    all.map(({ rt }) =>
      Promise.race([
        Promise.resolve().then(() => rt.dispose()),
        new Promise((_, rej) => setTimeout(() => rej(new Error('dispose timed out after 120 s')), 120_000).unref?.()),
      ]),
    ),
  );
  const failures = results
    .map((r, i) => (r.status === 'rejected' ? `${all[i]!.id}: ${String((r.reason as Error)?.message ?? r.reason)}` : null))
    .filter((x): x is string => !!x);
  const ok = all.length - failures.length;
  const msg = `disposed ${ok}/${all.length} runtimes (${why}) in ${Date.now() - t0} ms${failures.length ? '; failures: ' + failures.join('; ') : ''}`;
  console.log(`[engine] ${gameId}: ${msg}`);
  try {
    log?.(failures.length ? 'warn' : 'info', msg);
  } catch {
    /* ignore */
  }
  return { ok, failed: failures.length };
}

/** Waits until the registered wake callback is called (or abort). */
function waitWake(register: (w: () => void) => void, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((res) => {
    const onAbort = () => res();
    register(() => {
      signal?.removeEventListener('abort', onAbort);
      res();
    });
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Resolves with the call's value, or the fallback on timeout/error/abort. Never rejects. */
async function guarded<T>(
  label: string,
  fn: () => Promise<T>,
  fallback: () => T,
  ms: number,
  log: (level: 'warn' | 'error', msg: string) => void,
  signal?: AbortSignal,
): Promise<{ value: T; ok: boolean }> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: T, ok: boolean, why?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (!ok && why && !signal?.aborted) log('warn', `${label}: ${why} -> fallback`);
      resolve({ value, ok });
    };
    const onAbort = () => finish(fallback(), false);
    const timer = setTimeout(() => finish(fallback(), false, `timed out after ${ms} ms`), ms);
    signal?.addEventListener('abort', onAbort, { once: true });
    let p: Promise<T>;
    try {
      p = Promise.resolve(fn());
    } catch (err) {
      finish(fallback(), false, String((err as Error)?.message ?? err));
      return;
    }
    p.then(
      (v) => finish(v, true),
      (err) => finish(fallback(), false, String((err as Error)?.message ?? err)),
    );
  });
}

function clamp01(v: unknown, dflt: number): number {
  const n = Number(v);
  if (v === undefined || v === null || v === '' || !Number.isFinite(n)) return dflt;
  return Math.min(1, Math.max(0, n));
}

export function normalizeConfig(c: GameConfig): GameConfig {
  const n = Math.round(Number(c.agentCount) || DEFAULT_CONFIG.agentCount);
  return {
    ...DEFAULT_CONFIG,
    ...c,
    agentCount: Math.min(MAX_AGENTS, Math.max(MIN_AGENTS, n)),
    roomSize: Math.max(1, Math.round(Number(c.roomSize) || DEFAULT_CONFIG.roomSize)),
    rounds: Math.max(1, Math.round(Number(c.rounds) || DEFAULT_CONFIG.rounds)),
    questionsPerRound: Math.max(1, Math.round(Number(c.questionsPerRound) || 1)),
    eliminationsPerRound: Math.max(0, Math.round(Number(c.eliminationsPerRound) || 0)),
    impostorWhisperChance: clamp01(c.impostorWhisperChance, DEFAULT_CONFIG.impostorWhisperChance),
    maxAnswerChars: Math.max(20, Math.round(Number(c.maxAnswerChars) || DEFAULT_CONFIG.maxAnswerChars)),
    pacingMs: Math.max(0, Number(c.pacingMs ?? DEFAULT_CONFIG.pacingMs) || 0),
    models: { ...DEFAULT_CONFIG.models, ...(c.models ?? {}) },
    topics: c.topics?.length ? c.topics : DEFAULT_CONFIG.topics,
  };
}

/** Runs one full game. Always completes (fallbacks everywhere) unless aborted. */
export async function runGame(opts: RunGameOptions): Promise<GameSnapshot> {
  const config = normalizeConfig(opts.config);
  const gameId = opts.gameId ?? `g-${Date.now().toString(36)}`;
  const signal = opts.signal;
  const rng: Rng = makeRng(opts.seed ?? Math.floor(Math.random() * 2 ** 31));
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const pacing = config.pacingMs;
  const factory = opts.factory;

  let seq = 0;
  let snapshot: GameSnapshot | null = null;
  const emit = (payload: GameEventPayload): GameEvent => {
    const e = { ...payload, seq: ++seq, ts: Date.now(), gameId } as GameEvent;
    snapshot = reduceEvent(snapshot, e);
    try {
      opts.onEvent?.(e);
    } catch (err) {
      console.error('[engine] onEvent listener threw', err);
    }
    return e;
  };
  const log = (level: 'info' | 'warn' | 'error', message: string) => emit({ type: 'log', level, message });
  const beat = (mult = 1) => sleep(pacing * mult, signal);
  let msgN = 0;
  const say = (round: number, text: string, kind: Message['kind'] = 'announcement', agentId: AgentId = REFEREE_ID) =>
    emit({ type: 'message_posted', message: { id: `m${++msgN}`, round, agentId, kind, text, ts: Date.now() } });
  const phase = (round: number, p: Phase, endsAt: number | null = null) =>
    emit({ type: 'phase_changed', round, phase: p, endsAt });

  // ---- setup (synchronous: game_created is emitted before runGame first awaits) ----
  const { agents: initialAgents, rooms: layout } = buildAgents(config.agentCount, config.roomSize);
  let agents: AgentPublic[] = initialAgents;
  const ids = agents.map((a) => a.id);
  const roles: Record<AgentId, Role> = assignRoles(ids, config.impostorRatio, rng);
  const models: Record<AgentId, string> = {};
  for (const id of ids) models[id] = roles[id] === 'impostor' ? config.models.impostor : config.models.crew;
  const secrets: AgentSecret[] = ids.map((id) => ({ id, role: roles[id]!, model: models[id]! }));
  const impostorIds = ids.filter((id) => roles[id] === 'impostor');

  emit({ type: 'game_created', config, mode: factory.mode, agents, rooms: layout });
  emit({ type: 'roles_assigned', roles, models });
  phase(0, 'lobby');

  let referee: RefereeRuntime | null = null;
  let runtimes = new Map<AgentId, AgentRuntime>();
  const questions: RefereeQuestion[] = [];
  const answers: Answer[] = [];
  const votes: Vote[] = [];
  const eliminated: { agentId: AgentId; role: Role; round: number }[] = [];
  /** Latest suspicion map reported by each voter. */
  const suspicionBy = new Map<AgentId, Record<AgentId, number>>();

  const ready = new Set<AgentId>();
  const hooks = {
    emit(ev: GameEventPayload) {
      if (!ev || !HOOK_ALLOWED.has(ev.type)) {
        log('warn', `agent hook tried to emit disallowed event ${(ev as { type?: string })?.type}`);
        return;
      }
      if (ev.type === 'agent_ready') {
        if (ready.has(ev.agentId)) return;
        ready.add(ev.agentId);
      }
      emit(ev);
    },
  };

  const agentById = (id: AgentId) => agents.find((a) => a.id === id)!;
  const alive = () => agents.filter((a) => a.alive);
  const baseCtx = (self: AgentPublic, round: number, topic: string, p: Phase): AgentContext => ({
    gameId,
    round,
    totalRounds: config.rounds,
    topic,
    phase: p,
    self: { ...self },
    role: roles[self.id]!,
    fellowImpostors: roles[self.id] === 'impostor' ? impostorIds.filter((x) => x !== self.id) : [],
    alive: alive().map((a) => ({ ...a })),
    questions: questions.slice(),
    answers: answers.slice(),
    pastVotes: votes.filter((v) => v.round < round),
    eliminated: eliminated.slice(),
  });

  let disposed = false;
  /** Disposes every runtime once, logging the outcome (sandbox/disk cleanup must never leak silently). */
  const disposeAll = async (why: string, toGameLog: boolean) => {
    if (disposed) return;
    disposed = true;
    // After game_over only failures go to the game log (game_over stays last); success is console-only.
    await disposeRuntimes(gameId, why, referee, [...runtimes.values()], (level, msg) => {
      if (toGameLog || level !== 'info') log(level, msg);
    });
  };
  const finish = async (force = false): Promise<GameSnapshot> => {
    if (force || opts.disposeOnEnd !== false) await disposeAll(force ? 'game stopped' : 'game over', force);
    return snapshot!;
  };

  try {
    // ---- lobby: provision everything in parallel ----
    let gaveUp = false;
    const createP = Promise.resolve().then(() =>
      factory.createAll({ gameId, config, agents: agents.map((a) => ({ ...a })), secrets, hooks }),
    );
    // If provisioning finishes after we gave up (abort/timeout), release those runtimes instead of leaking them.
    createP.then(
      (r) => {
        if (!gaveUp || !r) return;
        void disposeRuntimes(gameId, 'late provisioning after stop/timeout', r.referee, r.agents, (level, msg) =>
          log(level, msg),
        );
      },
      () => undefined,
    );
    const created = await guarded(
      'factory.createAll',
      () => createP,
      () => null,
      Math.max(timeoutMs, 90_000),
      log,
      signal,
    );
    if (!created.ok || signal?.aborted) gaveUp = true;
    if (signal?.aborted) throw new Aborted();
    if (!created.value) {
      log('error', 'Agent provisioning failed; cannot run the game.');
      throw new Error('agent provisioning failed');
    }
    referee = created.value.referee;
    runtimes = new Map(created.value.agents.map((r) => [r.id, r]));
    opts.onRuntimes?.(created.value);
    const backend = factory.mode.disks === 'archil' ? 'archil' : 'memory';
    for (const id of [REFEREE_ID, ...ids]) {
      if (!ready.has(id)) {
        ready.add(id);
        emit({ type: 'agent_ready', agentId: id, backend });
      }
    }
    const missing = ids.filter((id) => !runtimes.has(id));
    if (missing.length) log('warn', `No runtime for ${missing.join(', ')}; using fallbacks.`);
    // The agents layer mutates factory.mode in place during createAll (egress verified, disk fallback).
    emit({ type: 'mode_updated', mode: { ...factory.mode } });
    await beat(1.5);

    // ---- rounds ----
    const topicPool: string[] = [];
    const nextTopic = () => {
      if (topicPool.length === 0) topicPool.push(...shuffle(config.topics, rng));
      return topicPool.shift()!;
    };

    for (let round = 1; round <= config.rounds; round++) {
      const topic = nextTopic();
      emit({
        type: 'round_started',
        round,
        topic,
        rooms: aliveRooms(layout, agents),
        agents: agents.map((a) => ({ ...a })),
      });
      await beat(0.5);

      for (let qi = 0; qi < config.questionsPerRound; qi++) {
        // ---- question ----
        phase(round, 'question');
        if (qi === 0) say(round, `Round ${round} of ${config.rounds}. Topic: ${topic}.`);
        await beat(0.5);
        const fallbackQ = (): RefereeQuestionDraft => ({
          text: `What is one notable recent headline about "${topic}"?`,
          answerKey: 'Any accurate, recent, sourced headline on the topic (referee fallback).',
          sources: [],
        });
        const qd = await guarded(
          'referee.askQuestion',
          async () => {
            if (!referee) throw new Error('no referee');
            return referee.askQuestion({
              gameId,
              round,
              totalRounds: config.rounds,
              topic,
              index: qi,
              previousQuestions: questions.slice(),
            });
          },
          fallbackQ,
          timeoutMs,
          log,
          signal,
        );
        if (signal?.aborted) throw new Aborted();
        const draft = qd.value?.text ? qd.value : fallbackQ();
        const question: RefereeQuestion = { id: `q${round}-${qi}`, round, index: qi, topic, text: String(draft.text) };
        questions.push(question);
        emit({ type: 'question_asked', question });
        emit({
          type: 'answer_key',
          key: { questionId: question.id, answer: String(draft.answerKey ?? ''), sources: draft.sources ?? [] },
        });
        say(round, question.text);
        await beat(1);

        // ---- answering ----
        phase(round, 'answering');
        await runAnswering(round, topic, question);
      }

      // ---- voting ----
      phase(round, 'voting');
      say(round, 'Answers are in. To the council — vote for who you think is the impostor.');
      for (const a of alive()) {
        emit({ type: 'agent_moved', agentId: a.id, to: { kind: 'council' } });
        await sleep(Math.min(50, pacing / 10), signal);
      }
      await beat(2);
      const roundVotes = await runVoting(round, topic);

      // ---- reveal ----
      phase(round, 'reveal');
      await beat(0.5);
      const tally = tallyVotes(roundVotes);
      const k = eliminationsFor(config, impostorIds.length, alive().length);
      let outIds = pickEliminatedMany(tally, k, rng);
      if (outIds.length === 0) {
        const r = pick(alive(), rng);
        outIds = r ? [r.id] : [];
      }
      for (let i = 0; i < outIds.length; i++) {
        const outId = outIds[i]!;
        const role = roles[outId]!;
        agents = agents.map((a) => (a.id === outId ? { ...a, alive: false, revealedRole: role } : a));
        eliminated.push({ agentId: outId, role, round });
        suspicionBy.delete(outId);
        emit({ type: 'agent_eliminated', round, agentId: outId, role, tally });
        emit({ type: 'agent_moved', agentId: outId, to: { kind: 'void' } });
        await beat(1);
        const name = agentById(outId).name;
        say(round, role === 'impostor' ? `${name} was an IMPOSTOR!` : `${name} was CREW.`);
        await beat(i < outIds.length - 1 ? 1 : 2);
      }
      for (const a of alive()) {
        emit({ type: 'agent_moved', agentId: a.id, to: { kind: 'room', roomId: a.roomId } });
        await sleep(Math.min(40, pacing / 10), signal);
      }
      await beat(1.5);

      const result = checkWinner(agents, roles, round, config.rounds);
      if (result) {
        phase(round, 'game_over');
        await beat(0.3);
        say(round, result.winner === 'crew' ? `Crew wins! ${result.reason}` : `Impostors win! ${result.reason}`);
        emit({ type: 'game_over', winner: result.winner, reason: result.reason, roles });
        return await finish();
      }
    }
    // Unreachable in practice (checkWinner ends the last round), but be safe.
    const reason = 'An impostor survived the final round.';
    phase(config.rounds, 'game_over');
    emit({ type: 'game_over', winner: 'impostor', reason, roles });
    return await finish();
  } catch (err) {
    if (err instanceof Aborted || signal?.aborted) {
      log('warn', 'Game stopped (replaced by a new game or server shutdown).');
      await finish(true).catch((e) => console.error('[engine] dispose on stop failed', e));
      return snapshot!;
    }
    log('error', `Engine crashed: ${String((err as Error)?.stack ?? err)}`);
    const round = (snapshot as GameSnapshot | null)?.round ?? 0;
    const anyImp = agents.some((a) => a.alive && roles[a.id] === 'impostor');
    phase(round, 'game_over');
    emit({
      type: 'game_over',
      winner: anyImp ? 'impostor' : 'crew',
      reason: 'Game aborted by an engine error.',
      roles,
    });
    return await finish();
  }

  /* ------------------------------------------------------------------ */

  async function runAnswering(round: number, topic: string, question: RefereeQuestion): Promise<void> {
    // SEALED: collect every answer (crew first, then impostors with optional whispers), reveal nothing
    // until all are in, then reveal everything in shuffled order, pacingMs apart.
    const living = alive();
    const crew = living.filter((a) => roles[a.id] === 'crew');
    const imps = living.filter((a) => roles[a.id] === 'impostor');
    const fallback = (): AnswerDraft => ({ text: "I'm not sure." });
    const ask = (agent: AgentPublic, whisper?: AnswerContext['whisper']): Promise<AnswerDraft> => {
      const ctx: AnswerContext = {
        ...baseCtx(agent, round, topic, 'answering'),
        phase: 'answering',
        question,
        maxChars: config.maxAnswerChars,
      };
      if (whisper) ctx.whisper = whisper;
      const rt = runtimes.get(agent.id);
      return guarded<AnswerDraft>(
        `${agent.id}.answer`,
        async () => {
          if (!rt) throw new Error('no runtime');
          return rt.answer(ctx);
        },
        fallback,
        timeoutMs,
        log,
        signal,
      ).then((r) => (r.value && typeof r.value === 'object' ? r.value : fallback()));
    };
    const normText = (d: AnswerDraft) => {
      let text = String(d?.text ?? '').trim() || "I'm not sure.";
      if (text.length > config.maxAnswerChars) text = text.slice(0, config.maxAnswerChars - 1) + '…';
      return text;
    };

    // Let viewers know why nothing shows up yet when collection is slow.
    const sealedTimer = setTimeout(() => {
      if (!signal?.aborted) say(round, 'Answers are sealed… revealing soon.');
    }, 5000);
    let drafts: { agent: AgentPublic; draft: AnswerDraft; whisperFrom?: AgentId }[];
    try {
      const crewDrafts = await Promise.all(crew.map(async (agent) => ({ agent, draft: await ask(agent) })));
      if (signal?.aborted) throw new Aborted();

      // Whispers: each impostor, with probability impostorWhisperChance, gets the gist of ONE random crew answer.
      const sources = crewDrafts
        .map((c) => ({ from: c.agent.id, gist: makeWhisper(normText(c.draft)) }))
        .filter((x): x is { from: AgentId; gist: string } => !!x.gist);
      const impDrafts = await Promise.all(
        imps.map(async (agent) => {
          let whisper: AnswerContext['whisper'];
          if (sources.length > 0 && rng() < config.impostorWhisperChance) {
            const src = pick(sources, rng)!;
            whisper = { text: src.gist, fromAgentId: src.from };
          }
          return { agent, draft: await ask(agent, whisper), whisperFrom: whisper?.fromAgentId };
        }),
      );
      if (signal?.aborted) throw new Aborted();
      drafts = [...crewDrafts, ...impDrafts];
    } finally {
      clearTimeout(sealedTimer);
    }

    for (const { agent, draft, whisperFrom } of shuffle(drafts, rng)) {
      if (signal?.aborted) throw new Aborted();
      const role = roles[agent.id]!;
      // copiedFrom is god-only bookkeeping: only trusted if it names this impostor's own whisper source.
      const copiedFrom = role === 'impostor' && whisperFrom && draft.copiedFrom === whisperFrom ? whisperFrom : undefined;
      const answer: Answer = {
        id: `${question.id}-${agent.id}`,
        questionId: question.id,
        round,
        agentId: agent.id,
        text: normText(draft),
        fabricated: role === 'impostor' && !copiedFrom,
      };
      if (draft.sourceUrl) answer.sourceUrl = String(draft.sourceUrl);
      if (copiedFrom) answer.copiedFrom = copiedFrom;
      answers.push(answer);
      emit({ type: 'answer_submitted', answer });
      await beat(1);
    }
  }

  async function runVoting(round: number, topic: string): Promise<Vote[]> {
    const voters = shuffle(alive(), rng);
    const roundVotes: Vote[] = [];
    const batchSize = Math.max(4, Math.ceil(voters.length / 6));
    let sinceSuspicion = 0;

    const emitSuspicion = () => {
      const scores: Record<AgentId, number> = {};
      const living = alive();
      for (const t of living) {
        let sum = 0;
        let n = 0;
        for (const v of living) {
          if (v.id === t.id) continue;
          const m = suspicionBy.get(v.id);
          if (!m) continue;
          const x = Number(m[t.id] ?? 0);
          sum += Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
          n++;
        }
        scores[t.id] = n ? sum / n : 0;
      }
      emit({ type: 'suspicion_updated', scores });
      sinceSuspicion = 0;
    };

    for (let i = 0; i < voters.length; i += batchSize) {
      const batch = voters.slice(i, i + batchSize);
      const queue: { voter: AgentPublic; d: VoteDecision; candidates: AgentId[] }[] = [];
      let wake: (() => void) | null = null;
      for (const voter of batch) {
        const candidates = alive()
          .filter((a) => a.id !== voter.id)
          .map((a) => a.id);
        const ctx: VoteContext = {
          ...baseCtx(voter, round, topic, 'voting'),
          phase: 'voting',
          candidates,
          votesSoFar: roundVotes.slice(),
        };
        const rt = runtimes.get(voter.id);
        const fb = (): VoteDecision => ({
          targetId: pick(candidates, rng)!,
          reason: 'Gut feeling.',
          suspicion: {},
        });
        void guarded<VoteDecision>(
          `${voter.id}.vote`,
          async () => {
            if (!rt) throw new Error('no runtime');
            return rt.vote(ctx);
          },
          fb,
          timeoutMs,
          log,
          signal,
        ).then((r) => {
          queue.push({ voter, d: r.value ?? fb(), candidates });
          const w = wake;
          wake = null;
          w?.();
        });
      }
      let emitted = 0;
      while (emitted < batch.length) {
        if (signal?.aborted) throw new Aborted();
        if (queue.length === 0) {
          await waitWake((w) => (wake = w), signal);
          continue;
        }
        const { voter, d, candidates } = queue.shift()!;
        let targetId = d?.targetId;
        if (!targetId || !candidates.includes(targetId)) {
          if (targetId) log('warn', `${voter.id} voted for invalid target ${targetId}; picking randomly.`);
          targetId = pick(candidates, rng)!;
        }
        const reason = String(d?.reason ?? '').trim().slice(0, 200) || '...';
        if (d?.suspicion && typeof d.suspicion === 'object') suspicionBy.set(voter.id, { ...d.suspicion });
        const vote: Vote = { round, voterId: voter.id, targetId, reason };
        roundVotes.push(vote);
        votes.push(vote);
        emit({ type: 'vote_cast', vote, tally: tallyVotes(roundVotes) });
        emitted++;
        sinceSuspicion++;
        if (sinceSuspicion >= 3) emitSuspicion();
        await beat(1);
      }
    }
    emitSuspicion();
    await beat(1);
    return roundVotes;
  }
}
