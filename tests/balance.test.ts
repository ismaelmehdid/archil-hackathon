import { describe, expect, it } from 'vitest';
import type { GameEvent } from '../packages/shared/contracts';
import { DEFAULT_CONFIG } from '../packages/shared/contracts';
import { runGame } from '../apps/server/src/game';
import { createAgentFactory } from '../apps/server/src/agents';

// Informational balance sweep (mock agents). Never fails on rates, only if a game doesn't finish.
// Target from contracts.ts: "hard to guess, not impossible" = crew win rate ~40-60% at 12 agents.
const GAMES = Number(process.env.BALANCE_GAMES || 40);
const CHANCES = [0, 0.25, 0.5, 0.75, 1];

describe('balance sweep (informational)', () => {
  it(`impostorWhisperChance sweep: ${GAMES} mock games x 12 agents each`, async () => {
    const rows: string[] = [];
    for (const chance of CHANCES) {
      let crewWins = 0;
      let rounds = 0;
      let roundsWithImpostorOut = 0;
      for (let g = 0; g < GAMES; g++) {
        const events: GameEvent[] = [];
        await runGame({
          gameId: `balance-${chance}-${g}`,
          config: { ...DEFAULT_CONFIG, agentCount: 12, mock: true, pacingMs: 0, impostorWhisperChance: chance },
          factory: createAgentFactory({ forceMock: true }),
          onEvent: (e) => events.push(e),
          seed: 1000 + g,
        });
        const over = events.at(-1);
        expect(over?.type).toBe('game_over');
        if (over?.type === 'game_over' && over.winner === 'crew') crewWins++;
        const roundNums = events.flatMap((e) => (e.type === 'round_started' ? [e.round] : []));
        rounds += roundNums.length;
        for (const r of roundNums) {
          if (events.some((e) => e.type === 'agent_eliminated' && e.round === r && e.role === 'impostor')) roundsWithImpostorOut++;
        }
      }
      const pct = (n: number, d: number) => `${((100 * n) / Math.max(1, d)).toFixed(0)}%`.padStart(5);
      rows.push(
        `  ${chance.toFixed(2).padStart(7)} | ${pct(crewWins, GAMES)} | ${(rounds / GAMES).toFixed(2).padStart(10)} | ${pct(roundsWithImpostorOut, rounds)}`,
      );
    }
    console.log(
      [
        `\n[balance] ${GAMES} mock games x 12 agents per row (target crew win ~40-60%)`,
        '  whisper | crew% | avg rounds | rounds w/ impostor out',
        '  --------+-------+------------+-----------------------',
        ...rows,
      ].join('\n'),
    );
  }, 600_000);
});
