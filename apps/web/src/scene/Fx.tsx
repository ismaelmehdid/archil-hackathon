'use client';

import { useLayoutEffect, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { GEO, MAT, POOF_MS, POOF_POOL, POOF_PUFFS, poofs } from './shared';

const dummy = new THREE.Object3D();

/** Unit directions for the puffs of one poof (a squashed ring, slightly upward). */
const DIRS = Array.from({ length: POOF_PUFFS }, (_, i) => {
  const a = (i / POOF_PUFFS) * Math.PI * 2 + (i % 2) * 0.3;
  return new THREE.Vector3(Math.cos(a), 0.35 + (i % 3) * 0.2, Math.sin(a)).normalize();
});

/** All "poof" clouds in ONE instanced mesh (one draw call), driven by the pooled poofs in shared.ts. */
export function Poofs() {
  const ref = useRef<THREE.InstancedMesh>(null);
  useFrame(() => {
    const m = ref.current;
    if (!m) return;
    const now = performance.now();
    let n = 0;
    for (let p = 0; p < POOF_POOL; p++) {
      const pf = poofs[p];
      const k = (now - pf.at) / POOF_MS;
      if (k < 0 || k >= 1) continue;
      const out = 1 - (1 - k) * (1 - k) * (1 - k);
      const s = Math.sin(Math.PI * Math.min(1, k * 1.15)) * 0.32 * pf.size;
      for (let i = 0; i < POOF_PUFFS; i++) {
        const d = DIRS[i];
        const r = (0.3 + out * 1.1) * pf.size;
        dummy.position.set(pf.x + d.x * r, pf.y + d.y * r + k * 0.6, pf.z + d.z * r);
        dummy.scale.setScalar(Math.max(0.0001, s * (0.8 + (i % 3) * 0.2)));
        dummy.rotation.set(k * 3 + i, k * 2, 0);
        dummy.updateMatrix();
        m.setMatrixAt(n++, dummy.matrix);
      }
    }
    m.count = n;
    if (n) m.instanceMatrix.needsUpdate = true;
  });
  return <instancedMesh ref={ref} args={[GEO.puff, MAT.puff, POOF_POOL * POOF_PUFFS]} frustumCulled={false} />;
}

const CLOUDS = 9;
const PUFFS_PER_CLOUD = 4;

/** Lazy drifting low-poly clouds around the arena (static instances, one slowly spinning group). */
export function Clouds({ radius }: { radius: number }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const group = useRef<THREE.Group>(null);
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    let n = 0;
    for (let c = 0; c < CLOUDS; c++) {
      const a = (c / CLOUDS) * Math.PI * 2 + 0.4;
      const r = radius * (3.0 + (c % 3) * 0.4);
      const cy = 16 + ((c * 5) % 7) * 1.6;
      const cs = 2.2 + (c % 4) * 0.5;
      for (let i = 0; i < PUFFS_PER_CLOUD; i++) {
        const off = (i - (PUFFS_PER_CLOUD - 1) / 2) * 1.1 * cs;
        const tang = a + Math.PI / 2;
        dummy.position.set(
          Math.cos(a) * r + Math.cos(tang) * off,
          cy + (i === 1 || i === 2 ? 0.45 * cs : 0),
          Math.sin(a) * r + Math.sin(tang) * off,
        );
        dummy.scale.set(cs * (i === 1 || i === 2 ? 1.05 : 0.75), cs * 0.7, cs * 0.85);
        dummy.rotation.set(0, a + i, 0);
        dummy.updateMatrix();
        m.setMatrixAt(n++, dummy.matrix);
      }
    }
    m.count = n;
    m.instanceMatrix.needsUpdate = true;
  }, [radius]);
  useFrame((_, dt) => {
    if (group.current) group.current.rotation.y += Math.min(dt, 0.1) * 0.012;
  });
  return (
    <group ref={group}>
      <instancedMesh ref={ref} args={[GEO.ball, MAT.cloud, CLOUDS * PUFFS_PER_CLOUD]} frustumCulled={false} />
    </group>
  );
}
