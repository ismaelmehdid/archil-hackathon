import { DEFAULT_CONFIG, type GameEvent } from '@susagent/shared';
import { runGame, createFakeAgentFactory } from './index';
import { createAgentFactory } from '../agents';
for (const [name, factory] of [['fake', createFakeAgentFactory(7)], ['agents-mock', createAgentFactory({ forceMock: true })]] as const) {
  for (const n of [12, 50]) {
    const evs: GameEvent[] = [];
    const t = Date.now();
    const snap = await runGame({ config: { ...DEFAULT_CONFIG, agentCount: n, pacingMs: 0, mock: true }, factory, onEvent: (e) => evs.push(e), seed: n });
    const counts: Record<string, number> = {};
    for (const e of evs) counts[e.type] = (counts[e.type] ?? 0) + 1;
    const seqOk = evs.every((e, i) => e.seq === i + 1);
    console.log(name, n, Date.now() - t, 'ms', snap.winner, snap.winReason, 'rounds', snap.round, 'seqOk', seqOk, 'last', evs.at(-1)?.type, 'elim', snap.eliminated.map(x=>x.agentId+':'+x.role).join(','));
    console.log('  ', JSON.stringify(counts));
    const logs = evs.filter((e) => e.type === 'log');
    if (logs.length) console.log('  logs', logs.slice(0, 5).map((e: any) => e.level + ' ' + e.message));
  }
}

// ---- stop/replace: every runtime must be disposed exactly once, snapshot marked stopped ----
{
  const { GameManager } = await import('./manager');
  const disposed: string[] = [];
  const wrap = (slowMs = 0): import('@susagent/shared').AgentFactory => {
    const inner = createFakeAgentFactory(3);
    return {
      mode: inner.mode,
      async createAll(input) {
        const r = await inner.createAll(input);
        if (slowMs) await new Promise((res) => setTimeout(res, slowMs));
        const tag = (x: { dispose(): Promise<void> }, id: string) => {
          x.dispose = async () => void disposed.push(`${input.gameId}:${id}`);
        };
        tag(r.referee, 'referee');
        for (const a of r.agents) tag(a, a.id);
        return r;
      },
    };
  };
  let slow = 0;
  const mgr = new GameManager({ getFactory: () => wrap(slow), keep: 10 });
  const cfg = { ...DEFAULT_CONFIG, agentCount: 6, pacingMs: 20, mock: true };
  const g1 = await mgr.create(cfg); // stopped mid-game
  await new Promise((r) => setTimeout(r, 300));
  slow = 400;
  const g2 = await mgr.create(cfg); // stopped during provisioning
  await new Promise((r) => setTimeout(r, 100));
  slow = 0;
  const g3 = await mgr.create({ ...cfg, pacingMs: 0 }); // runs to completion
  await mgr.get(g3)!.done;
  const g4 = await mgr.create({ ...cfg, pacingMs: 0 }); // g3 was already disposed at game_over
  await new Promise((r) => setTimeout(r, 700));
  await mgr.shutdown();
  for (const g of [g1, g2, g3, g4]) {
    const n = disposed.filter((d) => d.startsWith(g + ':')).length;
    const s = mgr.snapshot(g);
    const logs = mgr.get(g)?.log.filter((e) => e.type === 'log').map((e) => (e as { message: string }).message) ?? [];
    console.log('stop-test', g === g1 ? 'mid-game' : g === g2 ? 'provisioning' : g === g3 ? 'completed' : 'shutdown', 'disposed', n, '/ 7', 'status', s?.status, 'winReason', s?.winReason, '|', logs.filter((m) => /dispos|stopped/i.test(m)).join(' | '));
  }
}
