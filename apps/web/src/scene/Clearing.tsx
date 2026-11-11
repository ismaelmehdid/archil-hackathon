'use client';

import { memo, useLayoutEffect, useMemo, useRef, type ReactElement } from 'react';
import * as THREE from 'three';
import { seatAngle, type Layout } from './layout';
import { GEO, MAT } from './shared';
import { lowPoly } from './lowpoly';

/** Pastel tint per room, so neighbouring rooms on the home ring read as groups. */
const ROOM_TINTS = ['#ffd6e6', '#d6ecff', '#fff0bf', '#e3d9ff', '#d4f5df', '#ffe1c7', '#d9f3f7', '#f4dcff'].map(
  (c) => new THREE.Color(c),
);
const dummy = new THREE.Object3D();
const stoneMat = lowPoly(new THREE.MeshStandardMaterial({ color: '#fffaf0', flatShading: true, roughness: 0.9 }));

/** A flat hex stepping stone under every home seat: ONE instanced mesh. */
const SeatStones = memo(function SeatStones({ layout }: { layout: Layout }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const seats = useMemo(() => {
    const out: { a: number; room: number }[] = [];
    for (const id in layout.roomArcs) {
      const arc = layout.roomArcs[id];
      for (let s = 0; s < layout.roomSize; s++) out.push({ a: seatAngle(layout, id, s), room: arc.index });
    }
    return out;
  }, [layout]);
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    seats.forEach((s, i) => {
      dummy.position.set(Math.cos(s.a) * layout.homeRadius, -0.05, Math.sin(s.a) * layout.homeRadius);
      dummy.rotation.set(0, s.a, 0);
      dummy.scale.set(0.78, 0.1, 0.78);
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);
      m.setColorAt(i, ROOM_TINTS[s.room % ROOM_TINTS.length]);
    });
    m.count = seats.length;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [seats, layout.homeRadius]);
  return <instancedMesh key={seats.length} ref={ref} args={[GEO.hex, stoneMat, Math.max(1, seats.length)]} frustumCulled={false} />;
});

/** Raised hex stage around the referee, ringed by candy posts. Agents gather here to vote. */
const CouncilStage = memo(function CouncilStage({ radius: R }: { radius: number }) {
  const posts: ReactElement[] = [];
  const candy = [MAT.candyPink, MAT.candyBlue, MAT.candyYellow];
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2 + Math.PI / 6;
    posts.push(
      <group key={k} position={[Math.cos(a) * (R - 0.5), 0, Math.sin(a) * (R - 0.5)]}>
        <mesh geometry={GEO.stick} material={MAT.stick} position={[0, 0.5, 0]} />
        <mesh geometry={GEO.ball} material={candy[k % 3]} position={[0, 1.15, 0]} scale={0.28} />
      </group>,
    );
  }
  return (
    <group>
      <mesh geometry={GEO.hexTaper} material={MAT.councilRock} scale={[R + 0.4, 0.5, R + 0.4]} position={[0, -0.34, 0]} />
      <mesh geometry={GEO.hex} material={MAT.councilTop} scale={[R, 0.12, R]} position={[0, -0.06, 0]} />
      <mesh geometry={GEO.hex} material={MAT.councilInlay} scale={[R * 0.72, 0.14, R * 0.72]} position={[0, -0.06, 0]} />
      <mesh geometry={GEO.hex} material={MAT.councilTop} scale={[R * 0.62, 0.16, R * 0.62]} position={[0, -0.06, 0]} />
      {posts}
    </group>
  );
});

export function Clearing({ layout }: { layout: Layout }) {
  return (
    <group>
      <CouncilStage radius={layout.councilRadius} />
      <SeatStones layout={layout} />
    </group>
  );
}
