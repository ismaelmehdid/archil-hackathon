import { describe, expect, it } from 'vitest';
import type { AgentPublic, GameConfig, GameEvent, Role, Vote } from '../packages/shared/contracts';
import { DEFAULT_CONFIG } from '../packages/shared/contracts';
import {
  assignRoles,
  buildRooms,
  checkWinner,
  createFakeAgentFactory,
  eliminationsFor,
  pickEliminated,
  pickEliminatedMany,
  runGame,
  tallyVotes,
} from '../apps/server/src/game';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `a${String(i + 1).padStart(2, '0')}`);
const mkAgents = (spec: { id: string; alive: boolean }[]): AgentPublic[] =>
  spec.map((s, i) => ({ id: s.id, name: s.id, color: '#123456', roomId: 'r1', seat: i, alive: s.alive }));

/** Deterministic rng from a fixed sequence. */
const seqRng = (vals: number[]) => {
  let i = 0;
  return () => vals[i++ % vals.length];
};

describe('assignRoles', () => {
  it.each([
    [6, 1],
    [12, 2],
    [50, 8],
  ])('n=%i -> %i impostors (max(1, round(n/6)))', (n, expected) => {
    for (let trial = 0; trial < 5; trial++) {
      const roles = assignRoles(ids(n), 1 / 6);
      expect(Object.keys(roles).sort()).toEqual(ids(n));
      const imp = Object.values(roles).filter((r) => r === 'impostor').length;
      expect(imp).toBe(Math.max(1, Math.round(n / 6)));
      expect(imp).toBe(expected);
    }
  });

  it('always at least one impostor even for tiny ratio', () => {
    const roles = assignRoles(ids(6), 0.01);
    expect(Object.values(roles).filter((r) => r === 'impostor').length).toBe(1);
  });
});

describe('checkWinner', () => {
  const roles: Record<string, Role> = { a01: 'impostor', a02: 'impostor', a03: 'crew', a04: 'crew', a05: 'crew', a06: 'crew' };
  const alive = (dead: string[]) => mkAgents(ids(6).map((id) => ({ id, alive: !dead.includes(id) })));

  it('no winner mid-game with impostors alive and crew majority', () => {
    expect(checkWinner(alive([]), roles, 1, 5)).toBeNull();
    expect(checkWinner(alive(['a01']), roles, 2, 5)).toBeNull();
  });

  it('crew wins when all impostors are out', () => {
    expect(checkWinner(alive(['a01', 'a02']), roles, 2, 5)?.winner).toBe('crew');
  });

  it('crew wins on the last round if the last impostor is eliminated', () => {
    expect(checkWinner(alive(['a01', 'a02', 'a03']), roles, 5, 5)?.winner).toBe('crew');
  });

  it('impostors win at parity (impostors >= crew)', () => {
    // 2 impostors vs 2 crew
    expect(checkWinner(alive(['a03', 'a04']), roles, 2, 5)?.winner).toBe('impostor');
    // 1 impostor vs 1 crew
    expect(checkWinner(alive(['a01', 'a03', 'a04', 'a05']), roles, 3, 5)?.winner).toBe('impostor');
  });

  it('impostors win by surviving the last round', () => {
    expect(checkWinner(alive(['a03']), roles, 5, 5)?.winner).toBe('impostor');
    expect(checkWinner(alive(['a03']), roles, 4, 5)).toBeNull();
  });

  it('returns a reason string', () => {
    const r = checkWinner(alive(['a01', 'a02']), roles, 2, 5);
    expect(typeof r?.reason).toBe('string');
    expect(r?.reason.length).toBeGreaterThan(0);
  });
});

describe('tallyVotes / pickEliminated', () => {
  const v = (voterId: string, targetId: string): Vote => ({ round: 1, voterId, targetId, reason: '' });

  it('counts votes per target', () => {
    expect(tallyVotes([v('a01', 'a02'), v('a03', 'a02'), v('a02', 'a01')])).toEqual({ a02: 2, a01: 1 });
    expect(tallyVotes([])).toEqual({});
  });

  it('picks the unique max', () => {
    for (const r of [0, 0.5, 0.99]) expect(pickEliminated({ a01: 1, a02: 3, a03: 2 }, () => r)).toBe('a02');
  });

  it('tie-break picks only among the tied', () => {
    const tally = { a01: 3, a02: 3, a03: 1, a04: 2 };
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(pickEliminated(tally)!);
    for (const r of [0, 0.25, 0.49, 0.5, 0.75, 0.999]) seen.add(pickEliminated(tally, seqRng([r]))!);
    expect([...seen].sort()).toEqual(['a01', 'a02']);
  });

  it('empty tally -> null', () => {
    expect(pickEliminated({})).toBeNull();
  });
});

describe('multi-elimination: eliminationsFor / pickEliminatedMany', () => {
  const cfg = { ...DEFAULT_CONFIG, eliminationsPerRound: 0 };
  const imp = (n: number) => Math.max(1, Math.round(n / 6));

  it('auto k: 1 for 6 and 12 agents, 3 for 50 agents', () => {
    expect(eliminationsFor(cfg, imp(6), 6)).toBe(1);
    expect(eliminationsFor(cfg, imp(12), 12)).toBe(1);
    expect(eliminationsFor(cfg, imp(50), 50)).toBe(3);
  });

  it('explicit eliminationsPerRound wins; always capped at alive-1', () => {
    expect(eliminationsFor({ ...cfg, eliminationsPerRound: 2 }, 2, 12)).toBe(2);
    expect(eliminationsFor({ ...cfg, eliminationsPerRound: 10 }, 2, 4)).toBe(3);
    expect(eliminationsFor(cfg, imp(50), 3)).toBe(2);
    expect(eliminationsFor(cfg, 8, 2)).toBe(1);
  });

  it('top-k picks only from the highest tallies, most-voted first', () => {
    const tally = { a01: 5, a02: 4, a03: 4, a04: 4, a05: 1, a06: 0 };
    for (let i = 0; i < 100; i++) {
      const out = pickEliminatedMany(tally, 3);
      expect(out).toHaveLength(3);
      expect(out[0]).toBe('a01');
      expect(new Set(out).size).toBe(3);
      for (const id of out.slice(1)) expect(['a02', 'a03', 'a04']).toContain(id);
    }
    expect(pickEliminatedMany(tally, 1, () => 0.99)).toEqual(['a01']);
  });

  it('only voted targets count; k<=0 and empty tally return []', () => {
    expect(pickEliminatedMany({ a01: 2, a02: 0 }, 3)).toEqual(['a01']);
    expect(pickEliminatedMany({ a01: 2 }, 0)).toEqual([]);
    expect(pickEliminatedMany({}, 3)).toEqual([]);
  });

  it('never eliminates every alive agent even with eliminationsPerRound forced to 50', async () => {
    const events: GameEvent[] = [];
    await runGame({
      config: { ...DEFAULT_CONFIG, agentCount: 6, pacingMs: 0, mock: true, eliminationsPerRound: 50 },
      factory: createFakeAgentFactory(5),
      onEvent: (e) => events.push(e),
      seed: 5,
    });
    const created = events.find((e) => e.type === 'game_created');
    const n = created?.type === 'game_created' ? created.agents.length : 0;
    const out = events.filter((e) => e.type === 'agent_eliminated').length;
    expect(out).toBeLessThan(n);
    expect(events.at(-1)?.type).toBe('game_over');
  });
});

describe('buildRooms', () => {
  it('covers every agent exactly once with ceil(n/roomSize) rooms', () => {
    for (const n of [6, 12, 13, 50]) {
      const rooms = buildRooms(ids(n).map((id) => ({ id })), 6);
      expect(rooms).toHaveLength(Math.ceil(n / 6));
      const all = rooms.flatMap((r) => r.agentIds);
      expect(all.sort()).toEqual(ids(n));
      rooms.forEach((r, i) => expect(r.index).toBe(i));
      for (const r of rooms) expect(r.agentIds.length).toBeLessThanOrEqual(6);
    }
  });
});

describe('runGame with fake factory', () => {
  async function play(agentCount: number, seed?: number) {
    const config: GameConfig = { ...DEFAULT_CONFIG, agentCount, pacingMs: 0, mock: true };
    const events: GameEvent[] = [];
    const snapshot = await runGame({
      gameId: `test-${agentCount}-${seed ?? 'x'}`,
      config,
      factory: createFakeAgentFactory(seed),
      onEvent: (e) => events.push(e),
      seed,
    });
    return { config, events, snapshot };
  }

  it.each([
    [6, 1],
    [12, 2],
    [12, 3],
    [50, 7],
  ])('n=%i seed=%i: valid event stream ending in game_over', async (n, seed) => {
    const { config, events, snapshot } = await play(n, seed);

    // seq monotonic starting at 1, first game_created, ends with game_over
    expect(events.length).toBeGreaterThan(0);
    events.forEach((e, i) => expect(e.seq).toBe(i + 1));
    expect(events[0].type).toBe('game_created');
    const overs = events.filter((e) => e.type === 'game_over');
    expect(overs).toHaveLength(1);
    expect(events.at(-1)!.type).toBe('game_over');
    expect(snapshot.winner).not.toBeNull();
    expect(snapshot.status).toBe('over');

    const rolesEv = events.find((e) => e.type === 'roles_assigned');
    expect(rolesEv).toBeDefined();
    const roles = rolesEv!.type === 'roles_assigned' ? rolesEv!.roles : {};
    expect(Object.values(roles).filter((r) => r === 'impostor').length).toBe(Math.max(1, Math.round(n / 6)));

    // walk rounds
    const roundStarts = events.map((e, i) => [e, i] as const).filter(([e]) => e.type === 'round_started');
    expect(roundStarts.length).toBeGreaterThanOrEqual(1);
    expect(roundStarts.length).toBeLessThanOrEqual(config.rounds);

    const aliveSet = new Set(Object.keys(roles));
    for (let r = 0; r < roundStarts.length; r++) {
      const [startEv, startIdx] = roundStarts[r];
      const endIdx = r + 1 < roundStarts.length ? roundStarts[r + 1][1] : events.length;
      const slice = events.slice(startIdx, endIdx);
      const round = startEv.type === 'round_started' ? startEv.round : -1;
      const alive = [...aliveSet].sort();

      const qIdx = slice.findIndex((e) => e.type === 'question_asked');
      expect(qIdx, `round ${round}: question_asked`).toBeGreaterThanOrEqual(0);

      const answers = slice.filter((e) => e.type === 'answer_submitted');
      const firstAnswerIdx = slice.findIndex((e) => e.type === 'answer_submitted');
      expect(firstAnswerIdx, `round ${round}: answers after question`).toBeGreaterThan(qIdx);
      expect(answers.map((e) => (e.type === 'answer_submitted' ? e.answer.agentId : '')).sort(), `round ${round}: one answer per alive agent`).toEqual(alive);

      const votes = slice.filter((e) => e.type === 'vote_cast');
      const firstVoteIdx = slice.findIndex((e) => e.type === 'vote_cast');
      const lastAnswerIdx = slice.map((e) => e.type).lastIndexOf('answer_submitted');
      expect(firstVoteIdx, `round ${round}: votes after answers`).toBeGreaterThan(lastAnswerIdx);
      const voters = votes.map((e) => (e.type === 'vote_cast' ? e.vote.voterId : ''));
      expect(voters.sort(), `round ${round}: one vote per alive agent`).toEqual(alive);
      for (const e of votes) {
        if (e.type !== 'vote_cast') continue;
        expect(e.vote.targetId).not.toBe(e.vote.voterId);
        expect(aliveSet.has(e.vote.targetId)).toBe(true);
      }

      const elim = slice.flatMap((e) => (e.type === 'agent_eliminated' ? [e] : []));
      const impTotal = Object.values(roles).filter((x) => x === 'impostor').length;
      const k = eliminationsFor(config, impTotal, aliveSet.size);
      expect(elim.length, `round ${round}: 1..k eliminations (k=${k})`).toBeGreaterThanOrEqual(1);
      expect(elim.length, `round ${round}: 1..k eliminations (k=${k})`).toBeLessThanOrEqual(k);
      expect(elim.length, `round ${round}: never eliminates everyone`).toBeLessThan(aliveSet.size);
      const outIds = elim.map((e) => e.agentId);
      expect(new Set(outIds).size).toBe(outIds.length);
      const tally = elim[0].tally;
      for (const el of elim) {
        expect(aliveSet.has(el.agentId)).toBe(true);
        expect(el.role).toBe(roles[el.agentId]);
        expect(el.tally).toEqual(tally);
      }
      // eliminated agents are the top of the tally: each out-agent has >= votes than every survivor
      const minOut = Math.min(...outIds.map((id) => tally[id] ?? 0));
      for (const [id, n] of Object.entries(tally)) if (!outIds.includes(id)) expect(n, `${id} outvoted an eliminated agent`).toBeLessThanOrEqual(minOut);
      for (const id of outIds) aliveSet.delete(id);
    }

    // final winner consistent with survivors
    const over = overs[0];
    if (over.type === 'game_over') {
      const impAlive = [...aliveSet].filter((id) => roles[id] === 'impostor').length;
      expect(over.winner).toBe(impAlive === 0 ? 'crew' : 'impostor');
    }
  });

  it('50 agents completes too', async () => {
    const { events } = await play(50, 7);
    expect(events.at(-1)!.type).toBe('game_over');
  });
});
