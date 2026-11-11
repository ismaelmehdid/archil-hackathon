import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { lowPoly } from './lowpoly';

/** Clone + transform a geometry (used to bake pairs of face parts into ONE mesh = one draw call). */
function placed(g: THREE.BufferGeometry, x: number, y: number, z: number, rz = 0, sx = 1, sy = 1, sz = 1) {
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, rz)),
    new THREE.Vector3(sx, sy, sz),
  );
  return g.clone().applyMatrix4(m);
}
function pair(g: THREE.BufferGeometry, dx: number, y: number, z: number, rz = 0, s: [number, number, number] = [1, 1, 1]) {
  const merged = mergeGeometries([placed(g, -dx, y, z, rz, ...s), placed(g, dx, y, z, -rz, ...s)]);
  g.dispose();
  return merged;
}

/** Shared low-poly geometries (module scope, created once). */
export const GEO = {
  blob: new THREE.IcosahedronGeometry(0.5, 1),
  eye: new THREE.IcosahedronGeometry(0.075, 0),
  /** Both eyes in one mesh, centred on the eye line (scale.y = blink). */
  eyes: pair(new THREE.IcosahedronGeometry(0.082, 1), 0.155, 0, 0),
  /** Rosy cheeks, one mesh. */
  cheeks: pair(new THREE.IcosahedronGeometry(0.06, 0), 0.27, -0.04, 0.4, 0, [1.25, 0.7, 0.45]),
  /** Worried brows: inner ends raised, baked into one mesh. */
  brows: pair(new THREE.BoxGeometry(0.15, 0.035, 0.04), 0.16, 0, 0, 0.42),
  mouth: new THREE.IcosahedronGeometry(0.06, 1),
  hex: new THREE.CylinderGeometry(1, 1, 1, 6),
  hexTaper: new THREE.CylinderGeometry(1, 0.85, 1, 6),
  cone6: new THREE.ConeGeometry(1, 1, 6),
  trunk: new THREE.CylinderGeometry(0.07, 0.1, 0.5, 5),
  stick: new THREE.CylinderGeometry(0.06, 0.06, 1, 5),
  rock: new THREE.IcosahedronGeometry(0.3, 0),
  puff: new THREE.IcosahedronGeometry(1, 0),
  ball: new THREE.IcosahedronGeometry(1, 1),
  suspicionRing: new THREE.RingGeometry(0.56, 0.74, 14),
  selectRing: new THREE.RingGeometry(0.84, 0.98, 24),
  dot: new THREE.IcosahedronGeometry(1, 0),
  hat: new THREE.ConeGeometry(0.42, 1.0, 7),
  hatBand: new THREE.CylinderGeometry(0.3, 0.33, 0.12, 7),
  whistle: new THREE.CylinderGeometry(0.09, 0.09, 0.26, 7),
  gavelHead: new THREE.CylinderGeometry(0.2, 0.2, 0.55, 7),
};

export const PALETTE = {
  /** Fog/horizon tint (the sky itself is a CSS gradient behind a transparent canvas). */
  fog: '#f2f7fb',
  gold: '#ffc94d',
  ink: '#2d2a3e',
};

const std = (color: string) => lowPoly(new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.85 }));

export const MAT = {
  eye: new THREE.MeshBasicMaterial({ color: PALETTE.ink }),
  mouth: new THREE.MeshBasicMaterial({ color: '#5a2340' }),
  cheek: new THREE.MeshBasicMaterial({ color: '#ff9ec0', transparent: true, opacity: 0.85 }),
  grass: std('#93df7e'),
  grassDark: std('#7acd6c'),
  dirt: std('#e0aa76'),
  rock: std('#b9a3c9'),
  councilTop: std('#fff1d2'),
  councilInlay: std('#efdcb4'),
  councilRock: std('#d7c2e6'),
  tree: std('#5fd08e'),
  treeAlt: std('#b4e86b'),
  trunk: std('#b07a54'),
  flower: std('#ff8fb8'),
  candyPink: std('#ff8fb8'),
  candyBlue: std('#7cc8ff'),
  candyYellow: std('#ffd95a'),
  stick: std('#fffaf0'),
  cloud: lowPoly(new THREE.MeshStandardMaterial({ color: '#ffffff', flatShading: true, roughness: 1, emissive: '#ffffff', emissiveIntensity: 0.35 })),
  puff: lowPoly(new THREE.MeshStandardMaterial({ color: '#ffffff', flatShading: true, roughness: 1, emissive: '#fff4fb', emissiveIntensity: 0.4 })),
  gold: lowPoly(new THREE.MeshStandardMaterial({ color: PALETTE.gold, flatShading: true, metalness: 0.2, roughness: 0.55 })),
  hat: std('#a98bff'),
  gavelHead: std('#ff7aa8'),
  referee: lowPoly(new THREE.MeshStandardMaterial({
    color: '#fffaf0',
    flatShading: true,
    roughness: 0.8,
    emissive: '#4a3d22',
    emissiveIntensity: 0.25,
  })),
  select: new THREE.MeshBasicMaterial({ color: '#ffffff', side: THREE.DoubleSide, toneMapped: false }),
};

/** Live world positions of every blob (agent id -> group.position), read by vote beams. */
export const positions = new Map<string, THREE.Vector3>();

/** Fixed world position of the referee (council centre). */
export const REF_POS = new THREE.Vector3(0, 0, 0);

/** Who everyone is looking at: the newest speaker (agent id or REFEREE_ID) and when they spoke. */
export const focus: { id: string | null; at: number } = { id: null, at: 0 };

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

/* ------------------------------ poof clouds (pooled, no allocations) ------------------------------ */

export const POOF_POOL = 12;
export const POOF_PUFFS = 8;
export const POOF_MS = 750;
export interface Poof {
  x: number;
  y: number;
  z: number;
  size: number;
  at: number;
}
export const poofs: Poof[] = Array.from({ length: POOF_POOL }, () => ({ x: 0, y: 0, z: 0, size: 1, at: -1e9 }));
let poofNext = 0;

/** Spawns a cartoon "poof" of puffs at a world position (ring buffer, oldest recycled). */
export function spawnPoof(p: { x: number; y: number; z: number }, size = 1, at = performance.now()) {
  const slot = poofs[poofNext];
  poofNext = (poofNext + 1) % POOF_POOL;
  slot.x = p.x;
  slot.y = p.y;
  slot.z = p.z;
  slot.size = size;
  slot.at = at;
}
