import * as THREE from 'three';

/** Shared low-poly geometries (module scope, created once). */
export const GEO = {
  blob: new THREE.IcosahedronGeometry(0.5, 1),
  eye: new THREE.IcosahedronGeometry(0.075, 0),
  hex: new THREE.CylinderGeometry(1, 1, 1, 6),
  hexTaper: new THREE.CylinderGeometry(1, 0.85, 1, 6),
  cone6: new THREE.ConeGeometry(1, 1, 6),
  treeCone: new THREE.ConeGeometry(0.4, 1.1, 5),
  trunk: new THREE.CylinderGeometry(0.08, 0.1, 0.4, 5),
  rock: new THREE.IcosahedronGeometry(0.3, 0),
  suspicionRing: new THREE.RingGeometry(0.58, 0.76, 12),
  selectRing: new THREE.RingGeometry(0.84, 0.98, 24),
  dot: new THREE.IcosahedronGeometry(1, 0),
  hat: new THREE.ConeGeometry(0.45, 0.8, 6),
  hatBrim: new THREE.CylinderGeometry(0.62, 0.62, 0.08, 6),
};

export const PALETTE = {
  sky: '#1d2944',
  gold: '#e6b43c',
};

const std = (color: string) => new THREE.MeshStandardMaterial({ color, flatShading: true });

export const MAT = {
  eye: new THREE.MeshBasicMaterial({ color: '#141414' }),
  grass: std('#7bbf6a'),
  grassDark: std('#5f9e55'),
  dirt: std('#8a6a4a'),
  rock: std('#5e5149'),
  councilTop: std('#d8cfb8'),
  councilInlay: std('#b9ad93'),
  councilRock: std('#7a6f63'),
  tree: std('#2f7d4f'),
  trunk: std('#6b4a2f'),
  gold: new THREE.MeshStandardMaterial({ color: PALETTE.gold, flatShading: true, metalness: 0.3, roughness: 0.5 }),
  referee: new THREE.MeshStandardMaterial({
    color: '#f5f2ea',
    flatShading: true,
    emissive: '#3a3320',
    emissiveIntensity: 0.4,
  }),
  select: new THREE.MeshBasicMaterial({ color: '#ffffff', side: THREE.DoubleSide, toneMapped: false }),
};

/** Live world positions of every blob (agent id -> group.position), read by vote beams. */
export const positions = new Map<string, THREE.Vector3>();

/** Screen-label anchors: label key -> live world position + y offset (+ z-order boost). */
export interface Anchor {
  pos: THREE.Vector3;
  dy: number;
  boost?: number;
}
export const anchors = new Map<string, Anchor>();
/** DOM label elements keyed like anchors; positioned each frame by LabelProjector. */
export const labelEls = new Map<string, HTMLDivElement>();

export function truncate(s: string, n = 60): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

export const SPEECH_MS = 3200;
