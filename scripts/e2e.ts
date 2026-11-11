// `pnpm e2e` — headless full game, MOCK mode, in-process. Exits non-zero on failure.
process.env.SUSAGENT_MOCK = '1';

import type { GameConfig, GameEvent } from '../packages/shared/contracts';
import { DEFAULT_CONFIG } from '../packages/shared/contracts';
import { runGame } from '../apps/server/src/game';
import { createAgentFactory } from '../apps/server/src/agents';

const TIMEOUT_MS = 120_000;
const AGENTS = Number(process.env.E2E_AGENTS || 6);

const config: GameConfig = { ...DEFAULT_CONFIG, agentCount: AGENTS, mock: true, pacingMs: 5 };
const events: GameEvent[] = [];
const names: Record<string, string> = {};
const roles: Record<string, string> = {};
const t0 = Date.now();
const fail = (msg: string): never => {
  console.error(`\nE2E FAIL: ${msg}`);
  process.exit(1);
};

function onEvent(e: GameEvent) {
  events.push(e);
  switch (e.type) {
    case 'game_created':
      for (const a of e.agents) names[a.id] = a.name;
      console.log(`game ${e.gameId}: ${e.agents.length} agents, ${e.config.rounds} rounds`);
      break;
    case 'roles_assigned':
      Object.assign(roles, e.roles);
      console.log(`impostors: ${Object.keys(e.roles).filter((id) => e.roles[id] === 'impostor').map((id) => names[id] ?? id).join(', ')}`);
      break;
    case 'round_started':
      console.log(`\n-- round ${e.round}: ${e.topic}`);
      break;
    case 'question_asked':
      console.log(`   Q: ${e.question.text}`);
      break;
    case 'agent_eliminated':
      console.log(`   eliminated: ${names[e.agentId] ?? e.agentId} (${e.role}) tally=${JSON.stringify(e.tally)}`);
      break;
    case 'game_over':
      console.log(`\n== GAME OVER: ${e.winner} wins — ${e.reason}`);
      break;
    case 'log':
      if (e.level === 'error') console.log(`   [error] ${e.message}`);
      break;
  }
}

const timer = setTimeout(() => fail(`no game_over within ${TIMEOUT_MS / 1000}s`), TIMEOUT_MS);

try {
  await runGame({
    gameId: `e2e-${Date.now()}`,
    config,
    factory: createAgentFactory({ forceMock: true }),
    onEvent,
    timeoutMs: TIMEOUT_MS,
  });
} catch (err) {
  fail(`runGame threw: ${(err as Error)?.stack ?? err}`);
}
clearTimeout(timer);

// ---- assertions
const over = events.find((e) => e.type === 'game_over');
if (!over) fail('runGame resolved without a game_over event');
if (events[0]?.type !== 'game_created') fail(`first event is ${events[0]?.type}, expected game_created`);
events.forEach((e, i) => {
  if (e.seq !== i + 1) fail(`seq not monotonic from 1: event #${i} has seq ${e.seq}`);
});
const rounds = events.filter((e) => e.type === 'round_started').length;
if (rounds < 1 || rounds > config.rounds) fail(`played ${rounds} rounds, expected 1..${config.rounds}`);
for (const e of events) {
  if (e.type === 'search_performed' && roles[e.search.agentId] === 'impostor')
    fail(`impostor ${e.search.agentId} performed a search`);
}

console.log(`\nE2E OK: ${events.length} events, ${rounds} rounds, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
process.exit(0);
