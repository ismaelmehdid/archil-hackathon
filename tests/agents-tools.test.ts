import { describe, expect, it } from 'vitest';
import type { AgentPublic, AgentSecret, GameEventPayload, Role } from '../packages/shared/contracts';
import { DEFAULT_CONFIG } from '../packages/shared/contracts';
import { createAgentFactory, toolsFor } from '../apps/server/src/agents';

describe('impostors have no web_search tool', () => {
  it('toolsFor: web_search present for crew, absent for impostor', () => {
    expect(toolsFor('crew')).toContain('web_search');
    expect(toolsFor('impostor')).not.toContain('web_search');
  });

  it('mock runtimes: hasWebSearch false for impostors, true for crew', async () => {
    const n = 6;
    const agents: AgentPublic[] = Array.from({ length: n }, (_, i) => ({
      id: `a${String(i + 1).padStart(2, '0')}`,
      name: `Agent${i + 1}`,
      color: '#ff0000',
      roomId: 'r1',
      seat: i,
      alive: true,
    }));
    const roles: Role[] = ['impostor', 'crew', 'crew', 'crew', 'crew', 'impostor'];
    const secrets: AgentSecret[] = agents.map((a, i) => ({ id: a.id, role: roles[i], model: 'mock' }));
    const events: GameEventPayload[] = [];
    const factory = createAgentFactory({ forceMock: true });
    const { agents: runtimes, referee } = await factory.createAll({
      gameId: 'test-tools',
      config: { ...DEFAULT_CONFIG, agentCount: n, mock: true, pacingMs: 0 },
      agents,
      secrets,
      hooks: { emit: (e) => events.push(e) },
    });
    expect(runtimes).toHaveLength(n);
    for (const rt of runtimes) {
      const role = secrets.find((s) => s.id === rt.id)!.role;
      expect(rt.role).toBe(role);
      expect(rt.hasWebSearch, `${rt.id} (${role})`).toBe(role === 'crew');
    }
    await Promise.all([...runtimes.map((r) => r.dispose()), referee.dispose()]);
  });
});

describe('full mock game: impostors never search', () => {
  it('no search_performed event has an impostor agentId', async () => {
    const { runGame } = await import('../apps/server/src/game');
    const events: import('../packages/shared/contracts').GameEvent[] = [];
    await runGame({
      gameId: 'test-nosearch',
      config: { ...DEFAULT_CONFIG, agentCount: 12, mock: true, pacingMs: 0 },
      factory: createAgentFactory({ forceMock: true }),
      onEvent: (e) => events.push(e),
      seed: 42,
    });
    const rolesEv = events.find((e) => e.type === 'roles_assigned');
    expect(rolesEv?.type).toBe('roles_assigned');
    const roles = rolesEv && rolesEv.type === 'roles_assigned' ? rolesEv.roles : {};
    const searches = events.filter((e) => e.type === 'search_performed');
    for (const e of searches) {
      if (e.type === 'search_performed') expect(roles[e.search.agentId], `searcher ${e.search.agentId}`).not.toBe('impostor');
    }
    expect(events.at(-1)?.type).toBe('game_over');
  });
});
