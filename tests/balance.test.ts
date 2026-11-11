import { describe, expect, it } from 'vitest';
import type { GameEvent } from '../packages/shared/contracts';
import { DEFAULT_CONFIG } from '../packages/shared/contracts';
import { runGame } from '../apps/server/src/game';
import { createAgentFactory } from '../apps/server/src/agents';

// Informational only: prints the crew win rate over 20 mock games. Fails only if games don't finish.
describe('balance (informational)', () => {
  it('20 mock games x 12 agents: report crew win rate', async () => {
    const GAMES = 20;
    let crew = 0;
    const rounds: number[] = [];
    for (let g = 0; g < GAMES; g++) {
      const events: GameEvent[] = [];
      await runGame({
        gameId: `balance-${g}`,
        config: { ...DEFAULT_CONFIG, agentCount: 12, mock: true, pacingMs: 0 },
        factory: createAgentFactory({ forceMock: true }),
        onEvent: (e) => events.push(e),
        seed: 1000 + g,
      });
      const over = events.at(-1);
      expect(over?.type).toBe('game_over');
      if (over?.type === 'game_over' && over.winner === 'crew') crew++;
      rounds.push(events.filter((e) => e.type === 'round_started').length);
    }
    const avg = rounds.reduce((a, b) => a + b, 0) / GAMES;
    console.log(`[balance] crew won ${crew}/${GAMES} (${Math.round((crew / GAMES) * 100)}%), avg rounds ${avg.toFixed(1)}`);
  }, 180_000);
});
