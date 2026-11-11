import type { GameSnapshot, HallOfFameGame, HallOfFameStats, Role, Winner } from '@susagent/shared';

/** One row of the `games` table. */
export interface GameRow {
  id: string;
  ended_at: number;
  winner: Winner;
  rounds: number;
  agent_count: number;
  impostor_count: number;
}

/** One row of the `agent_stats` table. */
export interface AgentStatRow {
  game_id: string;
  agent_id: string;
  name: string;
  role: Role;
  /** 0/1 (SQLite has no booleans). */
  survived: number;
  correct_votes: number;
  votes_cast: number;
  times_voted_against: number;
  eliminated_round: number | null;
}

export interface GameRecord {
  game: GameRow;
  agents: AgentStatRow[];
}

/** Minimum crew games before someone can be "best detective". */
export const MIN_DETECTIVE_GAMES = 2;
export const LAST_GAMES = 10;

/** Reason the engine uses when it crashes; such games are not real wins. */
export const ENGINE_ERROR_REASON = 'Game aborted by an engine error.';

/**
 * Builds the rows for one finished game from its final snapshot. Null if the game has no winner, never
 * got to a vote (setup failure) or was aborted by an engine error.
 */
export function recordFromSnapshot(s: GameSnapshot, endedAt = Date.now()): GameRecord | null {
  if (!s.winner || s.round === 0 || s.votes.length === 0 || s.winReason === ENGINE_ERROR_REASON) return null;
  const roles = s.roles;
  const elimRound = new Map(s.eliminated.map((e) => [e.agentId, e.round]));
  const agents: AgentStatRow[] = s.agents.map((a) => {
    const mine = s.votes.filter((v) => v.voterId === a.id);
    return {
      game_id: s.gameId,
      agent_id: a.id,
      name: a.name,
      role: roles[a.id] ?? a.revealedRole ?? 'crew',
      survived: elimRound.has(a.id) ? 0 : 1,
      correct_votes: mine.filter((v) => roles[v.targetId] === 'impostor').length,
      votes_cast: mine.length,
      times_voted_against: s.votes.filter((v) => v.targetId === a.id).length,
      eliminated_round: elimRound.get(a.id) ?? null,
    };
  });
  return {
    game: {
      id: s.gameId,
      ended_at: endedAt,
      winner: s.winner,
      rounds: s.round,
      agent_count: s.agents.length,
      impostor_count: agents.filter((a) => a.role === 'impostor').length,
    },
    agents,
  };
}

/** Aggregates the hall of fame from raw rows. Same logic for every store backend. */
export function aggregate(games: GameRow[], rows: AgentStatRow[], backend: HallOfFameStats['backend']): HallOfFameStats {
  const totalGames = games.length;
  const crewWins = games.filter((g) => g.winner === 'crew').length;

  const det = new Map<string, { games: number; correct: number; cast: number }>();
  const imp = new Map<string, { games: number; survived: number; against: number }>();
  for (const r of rows) {
    if (r.role === 'crew') {
      const d = det.get(r.name) ?? { games: 0, correct: 0, cast: 0 };
      d.games++;
      d.correct += r.correct_votes;
      d.cast += r.votes_cast;
      det.set(r.name, d);
    } else {
      const d = imp.get(r.name) ?? { games: 0, survived: 0, against: 0 };
      d.games++;
      d.survived += r.survived ? 1 : 0;
      d.against += r.times_voted_against;
      imp.set(r.name, d);
    }
  }

  let bestDetective: HallOfFameStats['bestDetective'] = null;
  for (const [name, d] of det) {
    if (d.games < MIN_DETECTIVE_GAMES || d.cast === 0) continue;
    const ratio = d.correct / d.cast;
    if (
      !bestDetective ||
      ratio > bestDetective.ratio ||
      (ratio === bestDetective.ratio && d.correct > bestDetective.correctVotes)
    ) {
      bestDetective = { name, games: d.games, correctVotes: d.correct, votesCast: d.cast, ratio };
    }
  }

  let mostConvincingImpostor: HallOfFameStats['mostConvincingImpostor'] = null;
  for (const [name, d] of imp) {
    if (d.survived === 0) continue;
    const m = mostConvincingImpostor;
    if (!m || d.survived > m.survived || (d.survived === m.survived && d.against < m.timesVotedAgainst)) {
      mostConvincingImpostor = { name, impostorGames: d.games, survived: d.survived, timesVotedAgainst: d.against };
    }
  }

  const lastGames: HallOfFameGame[] = [...games]
    .sort((a, b) => b.ended_at - a.ended_at)
    .slice(0, LAST_GAMES)
    .map((g) => ({
      gameId: g.id,
      endedAt: g.ended_at,
      winner: g.winner,
      rounds: g.rounds,
      agentCount: g.agent_count,
      impostorCount: g.impostor_count,
    }));

  return {
    backend,
    totalGames,
    crewWins,
    crewWinRate: totalGames ? crewWins / totalGames : null,
    bestDetective,
    mostConvincingImpostor,
    lastGames,
  };
}
