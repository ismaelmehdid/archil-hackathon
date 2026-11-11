import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../packages/shared/contracts';
import { createFakeAgentFactory, runGame } from '../apps/server/src/game';
import { aggregate, recordFromSnapshot, type AgentStatRow, type GameRow } from '../apps/server/src/stats/aggregate';
import { MemoryStatsStore, createStatsStore, HALL_OF_FAME_DISK } from '../apps/server/src/stats/store';

const game = (id: string, winner: 'crew' | 'impostor', ended_at: number): GameRow => ({
  id,
  ended_at,
  winner,
  rounds: 3,
  agent_count: 4,
  impostor_count: 1,
});
const row = (game_id: string, name: string, role: 'crew' | 'impostor', o: Partial<AgentStatRow> = {}): AgentStatRow => ({
  game_id,
  agent_id: name.toLowerCase(),
  name,
  role,
  survived: 1,
  correct_votes: 0,
  votes_cast: 0,
  times_voted_against: 0,
  eliminated_round: null,
  ...o,
});

describe('hall of fame aggregation', () => {
  it('computes win rate, best detective (min games), most convincing impostor and last games', () => {
    const games = [game('g1', 'crew', 1), game('g2', 'impostor', 2), game('g3', 'crew', 3)];
    const rows = [
      // Ada: 2 crew games, 3/4 correct. Bob: 1 crew game, 1/1 correct (below min games). Cy: 2 games, 1/4.
      row('g1', 'Ada', 'crew', { correct_votes: 2, votes_cast: 2 }),
      row('g2', 'Ada', 'crew', { correct_votes: 1, votes_cast: 2 }),
      row('g1', 'Bob', 'crew', { correct_votes: 1, votes_cast: 1 }),
      row('g2', 'Cy', 'crew', { correct_votes: 1, votes_cast: 2 }),
      row('g3', 'Cy', 'crew', { correct_votes: 0, votes_cast: 2 }),
      // Impostors: Dee survived 1 of 2, Eve survived 1 of 1 with fewer votes against -> Eve wins the tie.
      row('g1', 'Dee', 'impostor', { survived: 0, eliminated_round: 1, times_voted_against: 3 }),
      row('g2', 'Dee', 'impostor', { times_voted_against: 2 }),
      row('g3', 'Eve', 'impostor', { times_voted_against: 1 }),
    ];
    const s = aggregate(games, rows, 'memory');
    expect(s.totalGames).toBe(3);
    expect(s.crewWins).toBe(2);
    expect(s.crewWinRate).toBeCloseTo(2 / 3);
    expect(s.bestDetective).toEqual({ name: 'Ada', games: 2, correctVotes: 3, votesCast: 4, ratio: 0.75 });
    expect(s.mostConvincingImpostor).toEqual({ name: 'Eve', impostorGames: 1, survived: 1, timesVotedAgainst: 1 });
    expect(s.lastGames.map((g) => g.gameId)).toEqual(['g3', 'g2', 'g1']);
  });

  it('is empty and null-safe before any game', () => {
    const s = aggregate([], [], 'memory');
    expect(s).toMatchObject({ totalGames: 0, crewWins: 0, crewWinRate: null, bestDetective: null, mostConvincingImpostor: null, lastGames: [] });
  });

  it('records real (fake-agent) games into the mock store', async () => {
    const store = new MemoryStatsStore();
    for (const seed of [1, 2, 3]) {
      const snap = await runGame({
        config: { ...DEFAULT_CONFIG, agentCount: 6, pacingMs: 0, mock: true },
        factory: createFakeAgentFactory(seed),
        onEvent: () => {},
        seed,
      });
      const rec = recordFromSnapshot(snap)!;
      expect(rec.agents).toHaveLength(6);
      expect(rec.game.impostor_count).toBe(Object.values(snap.roles).filter((r) => r === 'impostor').length);
      expect(rec.agents.reduce((n, a) => n + a.votes_cast, 0)).toBe(snap.votes.length);
      expect(rec.agents.reduce((n, a) => n + a.times_voted_against, 0)).toBe(snap.votes.length);
      for (const e of snap.eliminated) expect(rec.agents.find((a) => a.agent_id === e.agentId)).toMatchObject({ survived: 0, eliminated_round: e.round });
      await store.recordGame(snap);
      await store.recordGame(snap); // idempotent
    }
    const s = await store.getStats();
    expect(s.totalGames).toBe(3);
    expect(s.lastGames).toHaveLength(3);
    expect(s.crewWins + s.lastGames.filter((g) => g.winner === 'impostor').length).toBe(3);
  });

  it('uses the in-memory store in mock mode, and the persistent disk name avoids the cleanup pattern', () => {
    expect(createStatsStore({ mock: true }).backend).toBe('memory');
    expect(HALL_OF_FAME_DISK.startsWith('susagent-gm')).toBe(false);
  });
});
