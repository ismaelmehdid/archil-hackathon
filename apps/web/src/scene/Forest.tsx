'use client';

import { memo, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { lowPoly } from './lowpoly';

/**
 * The forest clearing everyone stands in: a flat meadow (y = 0) with the council stage in the middle,
 * ponds at the edge, and a dense low-poly forest climbing the hills all around. Everything is static and
 * instanced, so the whole forest costs ~10 draw calls regardless of tree count (no per-frame work).
 */

const GROUND_Y = -0.1;
const WATER_Y = -0.65;

function smoothstep(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function noise(x: number, z: number) {
  return (
    Math.sin(x * 0.13 + 1.3) * Math.cos(z * 0.11 - 0.7) * 1.6 +
    Math.sin((x - z) * 0.07) * 1.2 +
    Math.sin(x * 0.31) * Math.sin(z * 0.29) * 0.5
  );
}

/** Ground height at (x, z) around a clearing of radius R. */
function heightAt(x: number, z: number, R: number) {
  // R = clearing radius: dead flat inside (agents stand at y=0), ponds at the edge, hills behind.
  const r = Math.hypot(x, z);
  const edge = smoothstep(R * 0.97, R * 1.2, r);
  const bowl = smoothstep(R * 1.1, R * 3.0, r);
  return GROUND_Y + bowl * 11 + noise(x, z) * (edge * 1.3 + bowl * 0.9);
}

/** Deterministic PRNG so the forest looks the same on every load. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------ shared geometry + materials ------------------------------ */

function at(g: THREE.BufferGeometry, y: number, sx = 1, sy = 1, sz = 1) {
  return g.scale(sx, sy, sz).translate(0, y, 0);
}

const G = {
  trunk: at(new THREE.CylinderGeometry(0.12, 0.18, 1, 5), 0.5),
  pine: mergeGeometries([
    at(new THREE.ConeGeometry(0.95, 1.4, 6), 1.2),
    at(new THREE.ConeGeometry(0.7, 1.1, 6), 1.95),
    at(new THREE.ConeGeometry(0.42, 0.8, 6), 2.55),
  ]),
  round: at(new THREE.IcosahedronGeometry(0.85, 0), 1.55),
  tall: at(new THREE.IcosahedronGeometry(0.6, 0), 2.0, 1, 2.1, 1),
  bush: at(new THREE.IcosahedronGeometry(0.6, 0), 0.25, 1, 0.75, 1),
  rock: at(new THREE.DodecahedronGeometry(0.5, 0), 0.15, 1, 0.7, 1),
  stem: at(new THREE.CylinderGeometry(0.22, 0.3, 1, 6), 0.5),
  cap: at(new THREE.ConeGeometry(0.85, 0.65, 7), 1.25),
};

const lit = (color: string, extra: THREE.MeshStandardMaterialParameters = {}) =>
  lowPoly(new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.95, ...extra }));

const M = {
  ground: lit('#ffffff', { vertexColors: true, roughness: 1 }),
  water: lit('#8fd0ff', { roughness: 0.4, emissive: '#5aa8e6', emissiveIntensity: 0.15 }),
  trunk: lit('#b07a54'),
  foliage: lit('#ffffff'), // tinted per instance
  rock: lit('#ffffff'),
  stem: lit('#fff3e0'),
  cap: lit('#ff6f8f'),
};

const GREENS = ['#5fd08e', '#4fbf86', '#7fd97a', '#9be36f', '#3fae7e', '#6fcfa8', '#58c47c'].map((c) => new THREE.Color(c));
const ACCENTS = ['#ffb36b', '#ff9ec0', '#ffd95a', '#c7a6ff'].map((c) => new THREE.Color(c));
const ROCKS = ['#b9a3c9', '#d7c8e0', '#a99bbb', '#c9bfd6'].map((c) => new THREE.Color(c));

const SAND = new THREE.Color('#f3dca6');
const MEADOW = new THREE.Color('#a6e388');
const FOREST_FLOOR = new THREE.Color('#6cc07a');
const HILL = new THREE.Color('#9fd97a');

/* ------------------------------ terrain ------------------------------ */

function buildGround(R: number) {
  const size = R * 8;
  const seg = 64;
  const g = new THREE.PlaneGeometry(size, size, seg, seg).rotateX(-Math.PI / 2).toNonIndexed();
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const jitter = rng(7);
  // Jitter the grid a little so it doesn't read as a grid, then lift to the valley height.
  const cell = size / seg;
  const key = (x: number, z: number) => `${Math.round(x * 100)},${Math.round(z * 100)}`;
  const moved = new Map<string, [number, number, number]>();
  for (let i = 0; i < pos.count; i++) {
    const x0 = pos.getX(i);
    const z0 = pos.getZ(i);
    const k = key(x0, z0);
    let p = moved.get(k);
    if (!p) {
      const x = x0 + (jitter() - 0.5) * cell * 0.5;
      const z = z0 + (jitter() - 0.5) * cell * 0.5;
      p = [x, heightAt(x, z, R), z];
      moved.set(k, p);
    }
    pos.setXYZ(i, p[0], p[1], p[2]);
  }
  // Colour each facet by its centre height / distance (flat per-face colour = crisp low-poly look).
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  const tint = rng(11);
  for (let f = 0; f < pos.count; f += 3) {
    const cx = (pos.getX(f) + pos.getX(f + 1) + pos.getX(f + 2)) / 3;
    const cy = (pos.getY(f) + pos.getY(f + 1) + pos.getY(f + 2)) / 3;
    const cz = (pos.getZ(f) + pos.getZ(f + 1) + pos.getZ(f + 2)) / 3;
    const r = Math.hypot(cx, cz);
    if (cy < WATER_Y + 0.45) c.copy(SAND);
    else {
      c.copy(MEADOW).lerp(FOREST_FLOOR, smoothstep(R * 1.0, R * 1.5, r));
      c.lerp(HILL, smoothstep(R * 2.2, R * 3.2, r) * 0.7);
    }
    const j = 0.96 + tint() * 0.08;
    for (let v = 0; v < 3; v++) {
      colors[(f + v) * 3] = c.r * j;
      colors[(f + v) * 3 + 1] = c.g * j;
      colors[(f + v) * 3 + 2] = c.b * j;
    }
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.computeVertexNormals();
  return g;
}

function buildWater(R: number) {
  const size = R * 8;
  const g = new THREE.PlaneGeometry(size, size, 24, 24).rotateX(-Math.PI / 2).toNonIndexed();
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    pos.setY(i, WATER_Y + Math.sin(x * 0.9 + z * 0.4) * Math.cos(z * 0.7) * 0.12);
  }
  g.computeVertexNormals();
  return g;
}

/* ------------------------------ scatter ------------------------------ */

interface Item {
  x: number;
  y: number;
  z: number;
  s: number;
  sy: number;
  ry: number;
  color?: THREE.Color;
}

function scatter(R: number) {
  const rand = rng(1234);
  const pick = <T,>(a: T[]) => a[Math.floor(rand() * a.length)];
  const ring = (a: number, b: number) => Math.sqrt(a * a + (b * b - a * a) * rand());
  const out = { pine: [] as Item[], round: [] as Item[], tall: [] as Item[], bush: [] as Item[], rock: [] as Item[], shroom: [] as Item[] };

  const place = (list: Item[], rMin: number, rMax: number, sMin: number, sMax: number, colors?: THREE.Color[], minY = WATER_Y + 0.5) => {
    for (let tries = 0; tries < 6; tries++) {
      const r = ring(rMin, rMax);
      const a = rand() * Math.PI * 2;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const y = heightAt(x, z, R);
      if (y < minY) continue;
      // Bigger trees further out so the rim reads as a wall of forest.
      const grow = 1 + smoothstep(R * 1.3, R * 3.0, r) * 0.6;
      const s = (sMin + rand() * (sMax - sMin)) * grow;
      list.push({ x, y: y - 0.1, z, s, sy: s * (0.85 + rand() * 0.35), ry: rand() * Math.PI * 2, color: colors ? pick(colors) : undefined });
      return;
    }
  };

  const foliage = () => (rand() < 0.08 ? ACCENTS : GREENS);
  // Density scales with the clearing so big games still get a thick forest wall.
  const k = Math.min(2.5, Math.max(1, (R / 14) ** 2));
  const N = (n: number) => Math.round(n * k);
  // Dense forest ring climbing the hills all around the clearing.
  for (let i = 0; i < N(300); i++) place(out.pine, R * 1.12, R * 3.4, 1.1, 1.9, foliage());
  for (let i = 0; i < N(190); i++) place(out.round, R * 1.08, R * 3.2, 1.0, 1.7, foliage());
  for (let i = 0; i < N(110); i++) place(out.tall, R * 1.15, R * 3.3, 1.0, 1.6, foliage());
  // Props: a few loose trees at the forest edge, bushes, rocks and goofy mushrooms in the outer clearing.
  for (let i = 0; i < N(20); i++) place(pick([out.pine, out.round, out.tall]), R * 0.98, R * 1.12, 0.8, 1.2, GREENS);
  for (let i = 0; i < N(150); i++) place(out.bush, R - 2.2, R * 3.2, 0.6, 1.3, rand() < 0.15 ? ACCENTS : GREENS);
  for (let i = 0; i < N(60); i++) place(out.rock, R - 2.4, R * 3.0, 0.5, 1.6, ROCKS, WATER_Y - 0.2);
  for (let i = 0; i < N(12); i++) place(out.shroom, R - 2.2, R * 1.25, 0.8, 1.4);
  return out;
}

const dummy = new THREE.Object3D();
const WHITE = new THREE.Color('#ffffff');

/** One InstancedMesh for a list of items; matrices + colours are written once. */
function Instances({
  items,
  geometry,
  material,
  trunk = false,
}: {
  items: Item[];
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  trunk?: boolean;
}) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    items.forEach((it, i) => {
      dummy.position.set(it.x, it.y, it.z);
      dummy.rotation.set(0, it.ry, 0);
      if (trunk) dummy.scale.set(it.s, it.sy * 0.9, it.s);
      else dummy.scale.set(it.s, it.sy, it.s);
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);
      if (!trunk) m.setColorAt(i, it.color ?? WHITE);
    });
    m.count = items.length;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [items, trunk]);
  if (!items.length) return null;
  return <instancedMesh ref={ref} args={[geometry, material, items.length]} frustumCulled={false} />;
}

export const Forest = memo(function Forest({ radius }: { radius: number }) {
  // Quantise so tiny layout changes don't rebuild the valley.
  const R = Math.round(radius);
  const ground = useMemo(() => buildGround(R), [R]);
  const water = useMemo(() => buildWater(R), [R]);
  const items = useMemo(() => scatter(R), [R]);
  const trunks = useMemo(() => [...items.pine, ...items.round, ...items.tall], [items]);
  useLayoutEffect(
    () => () => {
      ground.dispose();
      water.dispose();
    },
    [ground, water],
  );
  return (
    <group>
      <mesh geometry={ground} material={M.ground} />
      <mesh geometry={water} material={M.water} />
      <Instances items={trunks} geometry={G.trunk} material={M.trunk} trunk />
      <Instances items={items.pine} geometry={G.pine} material={M.foliage} />
      <Instances items={items.round} geometry={G.round} material={M.foliage} />
      <Instances items={items.tall} geometry={G.tall} material={M.foliage} />
      <Instances items={items.bush} geometry={G.bush} material={M.foliage} />
      <Instances items={items.rock} geometry={G.rock} material={M.rock} />
      <Instances items={items.shroom} geometry={G.stem} material={M.stem} trunk />
      <Instances items={items.shroom} geometry={G.cap} material={M.cap} />
    </group>
  );
});
