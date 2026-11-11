import * as THREE from 'three';

export interface Layout {
  councilRadius: number;
  islandRadius: number;
  seatRadius: number;
  ringRadius: number;
  roomSize: number;
  roomCenters: Record<string, THREE.Vector3>;
  roomAngles: Record<string, number>;
}

export const BLOB_Y = 0.55; // centre height of a blob standing on y=0

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
  const islandRadius = Math.max(3.2, rs * 0.55 + 1);
  const seatRadius = islandRadius - 1.25;
  const councilRadius = Math.max(6, councilRingRadius(agentCount) + 2.6);
  const n = Math.max(1, rooms.length);
  const ringRadius = Math.max(
    councilRadius + islandRadius + 6,
    (n * (2 * islandRadius + 3)) / (Math.PI * 2),
  );
  const roomCenters: Record<string, THREE.Vector3> = {};
  const roomAngles: Record<string, number> = {};
  for (const r of rooms) {
    const a = (r.index / n) * Math.PI * 2 + Math.PI / 2;
    roomAngles[r.id] = a;
    roomCenters[r.id] = new THREE.Vector3(
      Math.cos(a) * ringRadius,
      Math.sin(r.index * 1.7) * 0.8,
      Math.sin(a) * ringRadius,
    );
  }
  return { councilRadius, islandRadius, seatRadius, ringRadius, roomSize: rs, roomCenters, roomAngles };
}

/** Writes the home-seat position of an agent into out. */
export function seatPosition(l: Layout, roomId: string, seat: number, out: THREE.Vector3): THREE.Vector3 {
  const c = l.roomCenters[roomId];
  if (!c) return out.set(0, BLOB_Y, 0);
  const a = (l.roomAngles[roomId] ?? 0) + Math.PI + ((seat + 0.5) / l.roomSize) * Math.PI * 2;
  return out.set(c.x + Math.cos(a) * l.seatRadius, c.y + BLOB_Y, c.z + Math.sin(a) * l.seatRadius);
}

/** Writes slot i of n on the council ring into out. */
export function councilPosition(i: number, n: number, out: THREE.Vector3): THREE.Vector3 {
  const r = councilRingRadius(n);
  const a = (i / Math.max(1, n)) * Math.PI * 2;
  return out.set(Math.cos(a) * r, BLOB_Y, Math.sin(a) * r);
}
