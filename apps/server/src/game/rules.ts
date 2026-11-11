import type { AgentId, AgentPublic, Role, Room, Tally, Vote, Winner } from '@susagent/shared';

/** Random source in [0, 1). */
export type Rng = () => number;

/** Deterministic PRNG (mulberry32). */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(arr: readonly T[], rng: Rng = Math.random): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export function pick<T>(arr: readonly T[], rng: Rng = Math.random): T | undefined {
  if (arr.length === 0) return undefined;
  return arr[Math.floor(rng() * arr.length)];
}

export function impostorCount(n: number, ratio: number): number {
  if (n <= 1) return 0;
  return Math.min(n - 1, Math.max(1, Math.round(n * ratio)));
}

/** Randomly assigns roles. impostors = max(1, round(n * ratio)), capped at n - 1. */
export function assignRoles(agentIds: AgentId[], ratio: number, rng: Rng = Math.random): Record<AgentId, Role> {
  const k = impostorCount(agentIds.length, ratio);
  const impostors = new Set(shuffle(agentIds, rng).slice(0, k));
  const roles: Record<AgentId, Role> = {};
  for (const id of agentIds) roles[id] = impostors.has(id) ? 'impostor' : 'crew';
  return roles;
}

/**
 * Win check, called after an elimination (round = the round just finished).
 * - no impostor alive -> crew
 * - impostors >= crew -> impostor (parity)
 * - round >= totalRounds and an impostor survives -> impostor
 */
export function checkWinner(
  agents: AgentPublic[],
  roles: Record<AgentId, Role>,
  round: number,
  totalRounds: number,
): { winner: Winner; reason: string } | null {
  const alive = agents.filter((a) => a.alive);
  const imp = alive.filter((a) => roles[a.id] === 'impostor').length;
  const crew = alive.length - imp;
  if (imp === 0) return { winner: 'crew', reason: 'All impostors were found.' };
  if (imp >= crew) return { winner: 'impostor', reason: 'Impostors reached parity with the crew.' };
  if (round >= totalRounds) return { winner: 'impostor', reason: 'An impostor survived the final round.' };
  return null;
}

export function tallyVotes(votes: Vote[]): Tally {
  const t: Tally = {};
  for (const v of votes) t[v.targetId] = (t[v.targetId] ?? 0) + 1;
  return t;
}

/** Most votes; ties broken randomly. null only for an empty tally. */
export function pickEliminated(tally: Tally, rng: Rng = Math.random): AgentId | null {
  let max = 0;
  let top: AgentId[] = [];
  for (const [id, n] of Object.entries(tally)) {
    if (n > max) {
      max = n;
      top = [id];
    } else if (n === max && n > 0) top.push(id);
  }
  return pick(top, rng) ?? null;
}

/**
 * Top-k targets by votes (only targets with >= 1 vote), ties broken randomly. Returns <= k ids,
 * ordered most-voted first. k <= 0 -> [].
 */
export function pickEliminatedMany(tally: Tally, k: number, rng: Rng = Math.random): AgentId[] {
  if (!(k > 0)) return [];
  const entries = Object.entries(tally).filter(([, n]) => n > 0);
  const keyed = entries.map(([id, n]) => ({ id, n, r: rng() }));
  keyed.sort((a, b) => b.n - a.n || a.r - b.r);
  return keyed.slice(0, Math.floor(k)).map((x) => x.id);
}

/**
 * Eliminations this round: config.eliminationsPerRound if > 0, else auto
 * max(1, ceil(impostorCount * 1.5 / rounds)); always capped at aliveCount - 1 (and >= 0).
 */
export function eliminationsFor(
  config: { eliminationsPerRound?: number; rounds: number },
  impostorCount: number,
  aliveCount: number,
): number {
  const fixed = Math.floor(Number(config.eliminationsPerRound) || 0);
  const k = fixed > 0 ? fixed : Math.max(1, Math.ceil((impostorCount * 1.5) / Math.max(1, config.rounds)));
  return Math.max(0, Math.min(k, aliveCount - 1));
}

export const ISLAND_NAMES = [
  'Ember Isle',
  'Tide Isle',
  'Moss Isle',
  'Frost Isle',
  'Dune Isle',
  'Coral Isle',
  'Ash Isle',
  'Mist Isle',
  'Sun Isle',
  'Storm Isle',
  'Fern Isle',
  'Onyx Isle',
];

/** ceil(n / roomSize) islands r1..rK with balanced sizes; contiguous ids; agentIds in seat order. */
export function buildRooms(agents: { id: AgentId }[], roomSize: number): Room[] {
  const n = agents.length;
  const size = Math.max(1, Math.floor(roomSize) || 1);
  const k = Math.max(1, Math.ceil(n / size));
  const base = Math.floor(n / k);
  const extra = n % k;
  const rooms: Room[] = [];
  let i = 0;
  for (let r = 0; r < k; r++) {
    const count = base + (r < extra ? 1 : 0);
    rooms.push({
      id: `r${r + 1}`,
      index: r,
      name: ISLAND_NAMES[r] ?? `Isle ${r + 1}`,
      agentIds: agents.slice(i, i + count).map((a) => a.id),
    });
    i += count;
  }
  return rooms;
}

export const AGENT_NAMES = [
  'Ada', 'Bram', 'Cleo', 'Dax', 'Esme', 'Finn', 'Gia', 'Hugo', 'Iris', 'Juno',
  'Kai', 'Lumi', 'Milo', 'Nova', 'Otto', 'Pia', 'Quinn', 'Rex', 'Sage', 'Theo',
  'Uma', 'Vik', 'Wren', 'Xan', 'Yara', 'Zed', 'Arlo', 'Bea', 'Cyrus', 'Dina',
  'Ezra', 'Faye', 'Gus', 'Hana', 'Ivo', 'Jade', 'Knox', 'Lena', 'Max', 'Nell',
  'Oren', 'Pax', 'Rhea', 'Soren', 'Tess', 'Ulla', 'Vera', 'Wes', 'Yuki', 'Zara',
];

function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const hex = (x: number) =>
    Math.round(x * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`;
}

/** Distinct colors: golden-angle hue spread with alternating lightness. */
export function agentColor(i: number): string {
  const h = (i * 137.508 + 10) % 360;
  const l = [58, 46, 68][i % 3]!;
  const s = [72, 62, 80][Math.floor(i / 3) % 3]!;
  return hslToHex(h, s, l);
}

export function agentId(i: number): AgentId {
  return `a${String(i + 1).padStart(2, '0')}`;
}

/** Creates N agents with ids a01.., unique names, distinct colors, islands + seats. */
export function buildAgents(n: number, roomSize: number): { agents: AgentPublic[]; rooms: Room[] } {
  const base = Array.from({ length: n }, (_, i) => ({ id: agentId(i) }));
  const rooms = buildRooms(base, roomSize);
  const where = new Map<AgentId, { roomId: string; seat: number }>();
  for (const r of rooms) r.agentIds.forEach((id, seat) => where.set(id, { roomId: r.id, seat }));
  const agents: AgentPublic[] = base.map((b, i) => ({
    id: b.id,
    name: AGENT_NAMES[i] ?? `Agent${i + 1}`,
    color: agentColor(i),
    roomId: where.get(b.id)!.roomId,
    seat: where.get(b.id)!.seat,
    alive: true,
  }));
  return { agents, rooms };
}

/** Current island layout restricted to alive agents (seat order preserved). */
export function aliveRooms(rooms: Room[], agents: AgentPublic[]): Room[] {
  const alive = new Set(agents.filter((a) => a.alive).map((a) => a.id));
  return rooms.map((r) => ({ ...r, agentIds: r.agentIds.filter((id) => alive.has(id)) }));
}
