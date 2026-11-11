import * as THREE from 'three';

/**
 * Everyone lives on the ground in one forest clearing:
 *   referee at the centre -> council stage (inner ring, where votes happen)
 *   -> home ring (every agent's seat, rooms are neighbouring arcs of the same circle)
 *   -> forest all around.
 */
export interface Layout {
  councilRadius: number;
  /** Radius of the home ring where agents stand between votes. */
  homeRadius: number;
  /** Outer scale of the arena (camera framing, fog, clouds). Same as homeRadius. */
  ringRadius: number;
  /** Radius of the flat clearing; the forest starts just outside. */
  clearingRadius: number;
  roomSize: number;
  /** Per room: start angle + angular span of its arc on the home ring. */
  roomArcs: Record<string, { start: number; span: number; index: number }>;
}

export const BLOB_Y = 0.55; // centre height of a blob standing on y=0

const SEAT_SPACING = 1.75;
const ROOM_GAP = 1.6;

/** Ring radius around the referee for n agents at the council. */
export function councilRingRadius(n: number): number {
  return Math.max(4, (n * 1.7) / (Math.PI * 2));
}

export function computeLayout(
  rooms: { id: string; index: number }[],
  agentCount: number,
  roomSize: number,
): Layout {
  const rs = Math.max(1, roomSize);
  const n = Math.max(1, rooms.length);
  const councilRadius = Math.max(6, councilRingRadius(agentCount) + 2.6);
  const seats = Math.max(agentCount, n * rs);
  const homeRadius = Math.max(councilRadius + 4.5, (seats * SEAT_SPACING + n * ROOM_GAP) / (Math.PI * 2));
  const clearingRadius = homeRadius + 4;
  // Arcs proportional to seat counts, separated by a small gap so rooms still read as groups.
  const gapA = ROOM_GAP / homeRadius;
  const usable = Math.PI * 2 - gapA * n;
  const roomArcs: Layout['roomArcs'] = {};
  for (const r of rooms) {
    const span = usable / n;
    roomArcs[r.id] = { start: r.index * (span + gapA) + gapA / 2, span, index: r.index };
  }
  return { councilRadius, homeRadius, ringRadius: homeRadius, clearingRadius, roomSize: rs, roomArcs };
}

/** Home angle of an agent on the home ring. */
export function seatAngle(l: Layout, roomId: string, seat: number): number {
  const arc = l.roomArcs[roomId];
  if (!arc) return 0;
  return arc.start + ((seat + 0.5) / l.roomSize) * arc.span;
}

/** Writes the home-seat position of an agent into out. */
export function seatPosition(l: Layout, roomId: string, seat: number, out: THREE.Vector3): THREE.Vector3 {
  if (!l.roomArcs[roomId]) return out.set(0, BLOB_Y, 0);
  const a = seatAngle(l, roomId, seat);
  return out.set(Math.cos(a) * l.homeRadius, BLOB_Y, Math.sin(a) * l.homeRadius);
}

/** Writes slot i of n on the council ring into out. */
export function councilPosition(i: number, n: number, out: THREE.Vector3): THREE.Vector3 {
  const r = councilRingRadius(n);
  const a = ((i + 0.5) / Math.max(1, n)) * Math.PI * 2;
  return out.set(Math.cos(a) * r, BLOB_Y, Math.sin(a) * r);
}
