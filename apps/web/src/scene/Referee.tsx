'use client';

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { REFEREE_ID } from '@susagent/shared';
import { GEO, MAT, anchors } from './shared';

const REF_POS = new THREE.Vector3(0, 0, 0);

/** Big white/gold blob with a cone hat, fixed at the council centre. */
export function Referee() {
  const bob = useRef<THREE.Group>(null);
  useEffect(() => {
    anchors.set(REFEREE_ID, { pos: REF_POS, dy: 3.0, boost: 100 });
    return () => void anchors.delete(REFEREE_ID);
  }, []);

  useFrame((state) => {
    const b = bob.current;
    if (!b) return;
    const t = state.clock.elapsedTime;
    b.position.y = 1.15 + Math.sin(t * 1.6) * 0.08;
    b.rotation.y = Math.sin(t * 0.4) * 0.6;
  });

  return (
    <group>
      <mesh geometry={GEO.hex} material={MAT.gold} scale={[1.2, 0.2, 1.2]} position={[0, 0.1, 0]} />
      <group ref={bob} position={[0, 1.15, 0]}>
        <mesh geometry={GEO.blob} material={MAT.referee} scale={1.9} />
        <mesh geometry={GEO.eye} material={MAT.eye} scale={1.6} position={[-0.3, 0.2, 0.84]} />
        <mesh geometry={GEO.eye} material={MAT.eye} scale={1.6} position={[0.3, 0.2, 0.84]} />
        <mesh geometry={GEO.hatBrim} material={MAT.gold} position={[0, 0.82, 0]} />
        <mesh geometry={GEO.hat} material={MAT.gold} position={[0, 1.25, 0]} />
      </group>
    </group>
  );
}
