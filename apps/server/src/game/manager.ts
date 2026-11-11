import {
  REFEREE_ID,
  type AgentFactory,
  type AgentId,
  type AgentRuntime,
  type DiskSnapshot,
  type GameConfig,
  type GameEvent,
  type GameSnapshot,
  type ModeInfo,
  type RefereeRuntime,
} from '@susagent/shared';
import { runGame } from './engine';
import { reduceEvent } from './reducer';

export interface GameRun {
  gameId: string;
  config: GameConfig;
  mode: ModeInfo;
  log: GameEvent[];
  snapshot: GameSnapshot | null;
  abort: AbortController;
  runtimes: { referee: RefereeRuntime; agents: AgentRuntime[] } | null;
  done: Promise<GameSnapshot | null>;
  over: boolean;
  /** Stopped before game_over (replaced or shutdown). */
  stopped?: boolean;
}

export type EventListener = (e: GameEvent) => void;

export interface GameManagerOptions {
  /** Returns the agent factory to use for a game with this config. */
  getFactory: (config: GameConfig) => AgentFactory | Promise<AgentFactory>;
  /** Called after each game_over (index.ts uses it for AUTO_START restarts). */
  onGameOver?: (run: GameRun) => void;
  timeoutMs?: number;
  /** How many finished games to keep in memory. Default 3. */
  keep?: number;
}

/** Owns the running game, its event log, subscribers and runtimes. */
export class GameManager {
  private games = new Map<string, GameRun>();
  private order: string[] = [];
  private currentId: string | null = null;
  /** listeners keyed by gameId or 'current' */
  private listeners = new Map<string, Set<EventListener>>();
  private counter = 0;
  lastMode: ModeInfo | null = null;

  constructor(private opts: GameManagerOptions) {}

  get currentGameId(): string | null {
    return this.currentId;
  }

  resolveId(id: string): string | null {
    return id === 'current' ? this.currentId : id;
  }

  get(id: string): GameRun | undefined {
    const gid = this.resolveId(id);
    return gid ? this.games.get(gid) : undefined;
  }

  snapshot(id: string): GameSnapshot | null {
    return this.get(id)?.snapshot ?? null;
  }

  /** Stops the running game (if any) and starts a new one. Resolves once game_created is emitted. */
  async create(config: GameConfig): Promise<string> {
    const prev = this.currentId ? this.games.get(this.currentId) : undefined;
    if (prev) this.stopRun(prev);

    const factory = await this.opts.getFactory(config);
    this.lastMode = factory.mode;
    const gameId = `g${Date.now().toString(36)}${(this.counter++).toString(36)}`;
    const run: GameRun = {
      gameId,
      config,
      mode: factory.mode,
      log: [],
      snapshot: null,
      abort: new AbortController(),
      runtimes: null,
      done: Promise.resolve(null),
      over: false,
    };
    this.games.set(gameId, run);
    this.order.push(gameId);
    this.currentId = gameId;
    this.prune();

    run.done = runGame({
      gameId,
      config,
      factory,
      signal: run.abort.signal,
      timeoutMs: this.opts.timeoutMs,
      // The engine disposes every runtime itself: right after game_over, or on abort. Disk snapshots
      // stay readable afterwards (agents keep a local cache), so the post-game disk route still works.
      disposeOnEnd: true,
      onRuntimes: (r) => {
        run.runtimes = r;
      },
      onEvent: (e) => this.onEvent(run, e),
    })
      .catch((err) => {
        console.error('[manager] runGame failed', err);
        return null;
      })
      .finally(() => {
        run.over = true;
      });
    return gameId;
  }

  private onEvent(run: GameRun, e: GameEvent) {
    run.log.push(e);
    try {
      run.snapshot = reduceEvent(run.snapshot, e);
    } catch (err) {
      console.error('[manager] reducer failed', err);
    }
    const fire = (key: string) => {
      const set = this.listeners.get(key);
      if (!set) return;
      for (const l of [...set]) {
        try {
          l(e);
        } catch (err) {
          console.error('[manager] listener threw', err);
        }
      }
    };
    fire(run.gameId);
    if (run.gameId === this.currentId) fire('current');
    if (e.type === 'mode_updated') {
      run.mode = { ...e.mode };
      this.lastMode = run.mode;
    }
    if (e.type === 'game_over') {
      run.over = true;
      try {
        this.opts.onGameOver?.(run);
      } catch (err) {
        console.error('[manager] onGameOver threw', err);
      }
    }
  }

  /**
   * Replays events with seq > since, then streams live. For 'current', follows game switches:
   * a new game's events arrive from seq 1 (starting with game_created).
   * Returns an unsubscribe function, or null if the game id is unknown.
   */
  subscribe(id: string, since: number, listener: EventListener): (() => void) | null {
    const key = id === 'current' ? 'current' : id;
    if (key !== 'current' && !this.games.has(key)) return null;
    const run = this.get(id);
    if (run) for (const e of run.log) if (e.seq > since) listener(e);
    let set = this.listeners.get(key);
    if (!set) this.listeners.set(key, (set = new Set()));
    set.add(listener);
    return () => {
      set!.delete(listener);
    };
  }

  async readDisk(id: string, agentId: AgentId): Promise<DiskSnapshot | null> {
    const run = this.get(id);
    if (!run?.runtimes) return null;
    const rt = agentId === REFEREE_ID ? run.runtimes.referee : run.runtimes.agents.find((a) => a.id === agentId);
    if (!rt) return null;
    return rt.readDisk();
  }

  /**
   * Stops a running game: abort it (the engine logs "Game stopped" and disposes every runtime itself,
   * including runtimes that finish provisioning late) and mark the snapshot over/'stopped'.
   * Finished games need nothing: the engine already disposed them at game_over.
   */
  private stopRun(run: GameRun) {
    if (run.over) return;
    run.abort.abort();
    run.stopped = true;
    this.markStopped(run);
    void run.done.then(() => this.markStopped(run));
  }

  private markStopped(run: GameRun) {
    if (run.snapshot && run.snapshot.status !== 'over') {
      run.snapshot = { ...run.snapshot, status: 'over', phaseEndsAt: null, winReason: 'stopped' };
    }
  }

  private prune() {
    const keep = this.opts.keep ?? 3;
    while (this.order.length > keep) {
      const old = this.order.shift()!;
      const run = this.games.get(old);
      if (run) this.stopRun(run);
      this.games.delete(old);
      this.listeners.delete(old);
    }
  }

  /** Stops everything and waits for disposal (server shutdown). */
  async shutdown() {
    const runs = [...this.games.values()];
    for (const run of runs) this.stopRun(run);
    await Promise.allSettled(runs.map((r) => r.done));
  }
}
