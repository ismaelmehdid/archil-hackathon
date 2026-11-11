'use client';

import { memo, useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import type { LiveVote } from '@susagent/shared';
import { useViewerStore } from '../store';
import { GEO, positions } from './shared';

const DOTS = 26;
const GROW_MS = 300;
const p0 = new THREE.Vector3();
const p1 = new THREE.Vector3();
const p2 = new THREE.Vector3();
const pt = new THREE.Vector3();
const dummy = new THREE.Object3D();

const Beam = memo(function Beam({ vote, color }: { vote: LiveVote; color: string }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const mat = useMemo(() => new THREE.MeshBasicMaterial({ color, toneMapped: false }), [color]);
  useEffect(() => () => mat.dispose(), [mat]);

  useFrame((state) => {
    const m = ref.current;
    if (!m) return;
    const a = positions.get(vote.voterId);
    const b = positions.get(vote.targetId);
    if (!a || !b) {
      m.count = 0;
      return;
    }
    const k = Math.min(1, Math.max(0, (performance.now() - vote.at) / GROW_MS));
    p0.copy(a).y += 0.55;
    p2.copy(b).y += 0.55;
    const d = p0.distanceTo(p2);
    p1.addVectors(p0, p2).multiplyScalar(0.5).y += 1 + d * 0.35;
    const n = Math.max(1, Math.ceil(k * DOTS));
    const t = state.clock.elapsedTime;
    for (let i = 0; i < n; i++) {
      const u = (i / (DOTS - 1)) * 1;
      const iu = 1 - u;
      pt.set(
        iu * iu * p0.x + 2 * iu * u * p1.x + u * u * p2.x,
        iu * iu * p0.y + 2 * iu * u * p1.y + u * u * p2.y,
        iu * iu * p0.z + 2 * iu * u * p1.z + u * u * p2.z,
      );
      const last = i === DOTS - 1;
      const s = last ? 0.4 : 0.15 + 0.04 * (0.5 + 0.5 * Math.sin(t * 9 - i * 0.7));
      dummy.position.copy(pt);
      dummy.scale.setScalar(s);
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);
    }
    m.count = n;
    m.instanceMatrix.needsUpdate = true;
  });

  return <instancedMesh ref={ref} args={[GEO.dot, mat, DOTS]} frustumCulled={false} />;
});

/** One dotted arc per live vote, voter -> target, in the voter's colour. */
export function VoteBeams() {
  const liveVotes = useViewerStore((s) => s.liveVotes);
  const agents = useViewerStore((s) => s.game?.agents);
  const colors = useMemo(() => {
    const m: Record<string, string> = {};
    for (const a of agents ?? []) m[a.id] = a.color;
    return m;
  }, [agents]);
  return (
    <group>
      {Object.values(liveVotes).map((v) => (
        <Beam key={v.voterId} vote={v} color={colors[v.voterId] ?? '#ffffff'} />
      ))}
    </group>
  );
}
