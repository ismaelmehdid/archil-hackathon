import * as archil from 'disk';
import { createDatabase, type SQLiteDatabase } from '@archildata/sqlite';
import type { GameSnapshot, HallOfFameStats } from '@susagent/shared';
import { withTimeout } from '../agents/archil';
import { aggregate, recordFromSnapshot, type AgentStatRow, type GameRecord, type GameRow } from './aggregate';

/**
 * Persistent hall-of-fame disk. Deliberately NOT named `susagent-gm*`: cleanup scripts delete every disk
 * matching that pattern, and per-game disks are `susagent-<gameId>-<agentId>` (gameIds start with "g").
 * This disk is never disposed.
 */
export const HALL_OF_FAME_DISK = 'susagent-hall-of-fame';
export const STATS_DB_PATH = 'stats.sqlite';
/** Upper bound on games loaded for aggregation (2 SQL reads per refresh, cached until the next write). */
const MAX_GAMES = 1000;

export interface StatsStore {
  readonly backend: HallOfFameStats['backend'];
  /** Records one finished game. Never throws. */
  recordGame(snapshot: GameSnapshot): Promise<void>;
  /** Current hall of fame. Never throws (falls back to empty stats). */
  getStats(): Promise<HallOfFameStats>;
}

/** In-memory store (mock mode / no ARCHIL_API_KEY / Archil failure fallback). */
export class MemoryStatsStore implements StatsStore {
  readonly backend = 'memory' as const;
  games: GameRow[] = [];
  rows: AgentStatRow[] = [];

  add(rec: GameRecord) {
    if (this.games.some((g) => g.id === rec.game.id)) return;
    this.games.push(rec.game);
    this.rows.push(...rec.agents);
  }

  async recordGame(snapshot: GameSnapshot): Promise<void> {
    const rec = recordFromSnapshot(snapshot);
    if (rec) this.add(rec);
  }

  async getStats(): Promise<HallOfFameStats> {
    return aggregate(this.games, this.rows, this.backend);
  }
}

/** SQLite on the persistent Archil disk. One transaction (= one tool call) per game. */
export class ArchilStatsStore implements StatsStore {
  readonly backend = 'archil' as const;
  private dbPromise: Promise<SQLiteDatabase> | null = null;
  private cache: HallOfFameStats | null = null;
  private loading: { version: number; p: Promise<HallOfFameStats> } | null = null;
  /** Bumped on every write attempt; a read that started before it must not be cached or reused. */
  private version = 0;
  /** After a failed open, don't retry (and stall /api/stats) for a while. */
  private openFailedAt = 0;
  /** Records whose write failed; replayed (idempotently) with the next write. */
  private pending: GameRecord[] = [];
  /** Keeps the API working (in-process) when Archil is unreachable. */
  private fallback = new MemoryStatsStore();

  private db(): Promise<SQLiteDatabase> {
    if (!this.dbPromise) {
      if (Date.now() - this.openFailedAt < 30_000) return Promise.reject(new Error('Archil SQLite unavailable (backing off)'));
      this.dbPromise = openDatabase().catch((err) => {
        this.dbPromise = null; // retry later
        this.openFailedAt = Date.now();
        throw err;
      });
    }
    return this.dbPromise;
  }

  async recordGame(snapshot: GameSnapshot): Promise<void> {
    const rec = recordFromSnapshot(snapshot);
    if (!rec) return;
    this.fallback.add(rec);
    const batch = [...this.pending, rec];
    this.pending = [];
    try {
      const db = await this.db();
      await withTimeout(
        db.transaction(
          batch.flatMap(({ game: g, agents }) => [
          db.write`INSERT OR IGNORE INTO games (id, ended_at, winner, rounds, agent_count, impostor_count)
                   VALUES (${g.id}, ${g.ended_at}, ${g.winner}, ${g.rounds}, ${g.agent_count}, ${g.impostor_count})`.run(),
          ...agents.map(
            (a) =>
              db.write`INSERT OR IGNORE INTO agent_stats (game_id, agent_id, name, role, survived, correct_votes, votes_cast, times_voted_against, eliminated_round)
                       VALUES (${a.game_id}, ${a.agent_id}, ${a.name}, ${a.role}, ${a.survived}, ${a.correct_votes}, ${a.votes_cast}, ${a.times_voted_against}, ${a.eliminated_round})`.run(),
          ),
          ]),
        ),
        20_000,
        'stats transaction',
      );
    } catch (err) {
      this.pending = batch.slice(-20); // INSERT OR IGNORE makes the replay idempotent
      console.warn(`[stats] recording game ${rec.game.id} to Archil SQLite failed: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
    } finally {
      // Even a timed-out write may have committed: never serve a cache from before it.
      this.version++;
      this.cache = null;
    }
  }

  async getStats(): Promise<HallOfFameStats> {
    if (this.cache) return this.cache;
    if (!this.loading || this.loading.version !== this.version) {
      const entry = { version: this.version, p: null as unknown as Promise<HallOfFameStats> };
      entry.p = this.load(entry.version).finally(() => {
        if (this.loading === entry) this.loading = null;
      });
      this.loading = entry;
    }
    return this.loading.p;
  }

  private async load(version: number): Promise<HallOfFameStats> {
    try {
      // One deadline for open + read so /api/stats never stalls the viewer for long.
      const [games, rows] = await withTimeout(
        this.db().then((db) => db.transaction([
          db.read<GameRow>`SELECT id, ended_at, winner, rounds, agent_count, impostor_count FROM games ORDER BY ended_at DESC LIMIT ${MAX_GAMES}`.all(),
          db.read<AgentStatRow>`SELECT s.game_id, s.agent_id, s.name, s.role, s.survived, s.correct_votes, s.votes_cast, s.times_voted_against, s.eliminated_round
                  FROM agent_stats s JOIN (SELECT id FROM games ORDER BY ended_at DESC LIMIT ${MAX_GAMES}) g ON g.id = s.game_id`.all(),
        ])),
        12_000,
        'stats read',
      );
      const stats = aggregate(games.map(numGame), rows.map(numRow), 'archil');
      if (version === this.version) this.cache = stats;
      return stats;
    } catch (err) {
      console.warn(`[stats] reading Archil SQLite failed: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
      return { ...(await this.fallback.getStats()), backend: 'memory' };
    }
  }
}

// SQLite may hand back bigints / strings depending on options; normalize.
const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const numGame = (g: GameRow): GameRow => ({
  ...g,
  ended_at: n(g.ended_at),
  rounds: n(g.rounds),
  agent_count: n(g.agent_count),
  impostor_count: n(g.impostor_count),
});
const numRow = (r: AgentStatRow): AgentStatRow => ({
  ...r,
  survived: n(r.survived),
  correct_votes: n(r.correct_votes),
  votes_cast: n(r.votes_cast),
  times_voted_against: n(r.times_voted_against),
  eliminated_round: r.eliminated_round === null || r.eliminated_round === undefined ? null : Number(r.eliminated_round),
});

/** Gets the persistent disk by name, or creates it. */
export async function getOrCreateHallOfFameDisk(): Promise<archil.Disk> {
  const found = await withTimeout(archil.listDisks({ name: HALL_OF_FAME_DISK }), 15_000, 'listDisks');
  const disk = found.find((d) => d.name === HALL_OF_FAME_DISK);
  if (disk) return disk;
  const { disk: created } = await withTimeout(archil.createDisk({ name: HALL_OF_FAME_DISK }), 20_000, 'createDisk');
  return created;
}

async function openDatabase(): Promise<SQLiteDatabase> {
  const disk = await getOrCreateHallOfFameDisk();
  const db = await withTimeout(createDatabase(disk, STATS_DB_PATH), 20_000, 'createDatabase');
  await withTimeout(
    db.transaction([
      db.write`CREATE TABLE IF NOT EXISTS games (
        id TEXT PRIMARY KEY,
        ended_at INTEGER NOT NULL,
        winner TEXT NOT NULL,
        rounds INTEGER NOT NULL,
        agent_count INTEGER NOT NULL,
        impostor_count INTEGER NOT NULL)`.run(),
      db.write`CREATE TABLE IF NOT EXISTS agent_stats (
        game_id TEXT NOT NULL REFERENCES games(id),
        agent_id TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        survived INTEGER NOT NULL,
        correct_votes INTEGER NOT NULL,
        votes_cast INTEGER NOT NULL,
        times_voted_against INTEGER NOT NULL,
        eliminated_round INTEGER,
        PRIMARY KEY (game_id, agent_id))`.run(),
      db.write`CREATE INDEX IF NOT EXISTS games_ended_at ON games(ended_at)`.run(),
    ]),
    20_000,
    'stats schema',
  );
  return db;
}

/** Archil SQLite when ARCHIL_API_KEY is set and not in mock mode; in-memory otherwise. */
export function createStatsStore(opts: { mock: boolean }): StatsStore {
  if (opts.mock || !process.env.ARCHIL_API_KEY || process.env.SUSAGENT_STATS === 'memory') return new MemoryStatsStore();
  return new ArchilStatsStore();
}
