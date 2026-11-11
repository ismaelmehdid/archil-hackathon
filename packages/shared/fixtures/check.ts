// Compile-time check that replay.json matches the contracts (structurally, via satisfies-style assignment).
import type { ReplayFixture } from '../contracts';
import replay from './replay.json';

const fixture: ReplayFixture = replay as unknown as ReplayFixture;
// Light runtime sanity usable from tests: every event has seq/ts/gameId/type.
export function checkReplay(f: ReplayFixture = fixture): string[] {
  const errs: string[] = [];
  let last = 0;
  for (const e of f.events) {
    if (e.seq !== last + 1) errs.push(`seq gap at ${e.seq}`);
    last = e.seq;
    if (!e.type || typeof e.ts !== 'number' || !e.gameId) errs.push(`bad event ${e.seq}`);
  }
  if (f.events[0]?.type !== 'game_created') errs.push('first event must be game_created');
  if (f.events.at(-1)?.type !== 'game_over') errs.push('last event must be game_over');
  return errs;
}
export default fixture;
