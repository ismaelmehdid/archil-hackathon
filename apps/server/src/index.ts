import Fastify from 'fastify';
import cors from '@fastify/cors';
import {
  API_ROUTES,
  type AgentFactory,
  type CreateGameRequest,
  type CreateGameResponse,
  type CurrentGameResponse,
  type GameConfig,
  type HallOfFameStats,
  type HealthResponse,
} from '@susagent/shared';
import { buildConfig, serverEnv } from './config';
import { GameManager, createFakeAgentFactory } from './game';
import { createAgentFactory } from './agents';
import { createStatsStore } from './stats/store';

/** Cross-game hall of fame: SQLite on a persistent Archil disk, or in-memory in mock mode. */
const statsStore = createStatsStore({ mock: serverEnv.mock || serverEnv.engineFake });

function getFactory(config: GameConfig): AgentFactory {
  if (serverEnv.engineFake) return createFakeAgentFactory(Date.now() & 0xffff);
  try {
    return createAgentFactory({ forceMock: config.mock || serverEnv.mock });
  } catch (err) {
    console.error('[server] createAgentFactory failed; using engine fake agents', err);
    return createFakeAgentFactory(Date.now() & 0xffff);
  }
}

let restartTimer: NodeJS.Timeout | null = null;
const clearRestart = () => {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = null;
};

const manager = new GameManager({
  getFactory,
  timeoutMs: serverEnv.agentTimeoutMs,
  onGameOver: (run) => {
    // Fire-and-forget: the store never throws, and the game never waits on it. Mock games stay out of
    // the persistent SQLite hall of fame.
    const mockGame = run.config.mock || run.mode.llm === 'mock';
    if (run.snapshot && !(mockGame && statsStore.backend === 'archil')) {
      const snap = run.snapshot;
      void statsStore.recordGame(snap).catch((err) => console.warn('[stats] recordGame failed', err));
    }
    if (!serverEnv.autoStart) return;
    clearRestart();
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (manager.currentGameId !== run.gameId) return; // someone already started another game
      void startGame({}).catch((err) => app.log.error(err));
    }, serverEnv.restartDelayMs);
  },
});

async function startGame(req: CreateGameRequest): Promise<string> {
  clearRestart();
  const config = buildConfig(req);
  const id = await manager.create(config);
  app.log.info(`game ${id} started: ${config.agentCount} agents, mock=${config.mock}, pacing=${config.pacingMs}ms`);
  return id;
}

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
await app.register(cors, { origin: true });

app.get(API_ROUTES.health, async (): Promise<HealthResponse> => {
  const run = manager.get('current');
  const mode = run?.mode ?? manager.lastMode ?? getFactory(buildConfig()).mode;
  return { ok: true, mode, gameId: manager.currentGameId };
});

app.post(API_ROUTES.games, async (req, reply): Promise<CreateGameResponse> => {
  const body = (req.body ?? {}) as CreateGameRequest;
  const gameId = await startGame(body);
  reply.code(201);
  return { gameId };
});

app.get(API_ROUTES.stats, async (): Promise<HallOfFameStats> => statsStore.getStats());

app.get(API_ROUTES.current, async (): Promise<CurrentGameResponse> => ({ gameId: manager.currentGameId }));

app.get<{ Params: { gameId: string } }>('/api/games/:gameId', async (req, reply) => {
  const snap = manager.snapshot(req.params.gameId);
  if (!snap) return reply.code(404).send({ error: 'game not found' });
  return snap;
});

app.get<{ Params: { gameId: string }; Querystring: { since?: string } }>(
  '/api/games/:gameId/events',
  (req, reply) => {
    const { gameId } = req.params;
    const since = Math.max(0, Number(req.query.since ?? 0) || 0);
    if (gameId !== 'current' && !manager.get(gameId)) {
      reply.code(404).send({ error: 'game not found' });
      return;
    }
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': (req.headers.origin as string | undefined) ?? '*',
      Vary: 'Origin',
    });
    res.write(': connected\n\n');
    let closed = false;
    const unsubscribe = manager.subscribe(gameId, since, (e) => {
      if (closed) return;
      res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
    });
    const ping = setInterval(() => {
      if (!closed) res.write(': ping\n\n');
    }, 15_000);
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(ping);
      unsubscribe?.();
    };
    req.raw.on('close', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
  },
);

app.get<{ Params: { gameId: string; agentId: string } }>(
  '/api/games/:gameId/agents/:agentId/disk',
  async (req, reply) => {
    try {
      const snap = await manager.readDisk(req.params.gameId, req.params.agentId);
      if (!snap) return reply.code(404).send({ error: 'agent or game not found' });
      return snap;
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: String((err as Error)?.message ?? err) });
    }
  },
);

const shutdown = async () => {
  clearRestart();
  await manager.shutdown().catch(() => undefined);
  await app.close().catch(() => undefined);
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: serverEnv.port, host: '0.0.0.0' });

if (serverEnv.autoStart) {
  await startGame({}).catch((err) => app.log.error(err));
}
