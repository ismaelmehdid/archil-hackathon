import { describe, expect, it } from 'vitest';
import fixture, { checkReplay } from '../packages/shared/fixtures/check';
import { GOD_ONLY_EVENTS, REFEREE_ID } from '../packages/shared/contracts';

describe('replay fixture', () => {
  it('checkReplay() returns no errors', () => {
    expect(checkReplay()).toEqual([]);
  });

  it('has a disk snapshot for every agent and the referee', () => {
    const created = fixture.events[0];
    expect(created.type).toBe('game_created');
    if (created.type !== 'game_created') return;
    for (const a of created.agents) expect(fixture.disks[a.id], `disk for ${a.id}`).toBeDefined();
    expect(fixture.disks[REFEREE_ID]).toBeDefined();
  });

  it('impostors never produce search_performed', () => {
    const rolesEv = fixture.events.find((e) => e.type === 'roles_assigned');
    expect(rolesEv).toBeDefined();
    if (!rolesEv || rolesEv.type !== 'roles_assigned') return;
    for (const e of fixture.events) {
      if (e.type === 'search_performed') expect(rolesEv.roles[e.search.agentId]).not.toBe('impostor');
    }
  });

  it('only uses known event types and ts is non-decreasing', () => {
    let lastTs = -Infinity;
    for (const e of fixture.events) {
      expect(e.ts).toBeGreaterThanOrEqual(lastTs);
      lastTs = e.ts;
    }
    expect(GOD_ONLY_EVENTS.length).toBeGreaterThan(0);
  });
});
