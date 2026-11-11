'use client';

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import type { AgentPublic } from '@susagent/shared';
import { useViewerStore } from '../store';
import { councilPosition, seatPosition, type Layout } from './layout';
import { GEO, MAT, anchors, positions } from './shared';
import { REVEAL_TO_MS } from './labels';

const GREEN = new THREE.Color('#3ddc84');
const ORANGE = new THREE.Color('#ff9f1c');
const RED = new THREE.Color('#ff2e2e');
const tmpColor = new THREE.Color();
const tmpV = new THREE.Vector3();

const FALL_MS = 3200;
const WALK_SPEED = 6.5;

function suspicionColor(s: number, out: THREE.Color) {
  const v = Math.min(1, Math.max(0, s));
  if (v < 0.5) out.copy(GREEN).lerp(ORANGE, v * 2);
  else out.copy(ORANGE).lerp(RED, (v - 0.5) * 2);
}

function lerpAngle(a: number, b: number, k: number) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}

interface Props {
  agent: AgentPublic;
  layout: Layout;
  /** Council slot among alive agents (-1 if dead). */
  slot: number;
  slotCount: number;
}

type Stage = 'alive' | 'falling' | 'gone';

export const AgentBlob = memo(function AgentBlob({ agent, layout, slot, slotCount }: Props) {
  const id = agent.id;
  const loc = useViewerStore((s) => s.game?.locations[id]);
  const suspicion = useViewerStore((s) => s.game?.suspicion[id] ?? 0);
  const glow = useViewerStore((s) => s.godMode && s.game?.roles[id] === 'impostor');
  const selected = useViewerStore((s) => s.selectedAgentId === id);
  const elimAt = useViewerStore((s) => s.eliminations[id]?.at);
  // Eliminated in an earlier round (e.g. SSE catch-up on connect): no fall/reveal, just gone.
  const elimOld = useViewerStore((s) => {
    const g = s.game;
    const e = g?.eliminated.find((x) => x.agentId === id);
    return !!g && !!e && e.round < g.round;
  });
  const selectAgent = useViewerStore((s) => s.selectAgent);

  const group = useRef<THREE.Group>(null);
  const bob = useRef<THREE.Group>(null);
  const target = useRef(new THREE.Vector3());
  const placed = useRef(false);
  const suspRef = useRef(suspicion);
  suspRef.current = suspicion;
  const phase = useMemo(() => (parseInt(id.replace(/\D/g, ''), 10) || 0) * 1.37, [id]);
  const fall = useRef<{ at: number; start: THREE.Vector3; dir: THREE.Vector3 } | null>(null);
  const [stage, setStage] = useState<Stage>('alive');

  const bodyMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: agent.color, flatShading: true }),
    [agent.color],
  );
  const ringMat = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: GREEN.clone(),
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.9,
        toneMapped: false,
      }),
    [],
  );
  useEffect(() => () => bodyMat.dispose(), [bodyMat]);
  useEffect(() => () => ringMat.dispose(), [ringMat]);

  useEffect(() => {
    bodyMat.emissive.set(glow ? '#ff1a1a' : '#000000');
    bodyMat.emissiveIntensity = glow ? 0.6 : 0;
  }, [glow, bodyMat]);

  // Target position from location.
  const locKind = loc?.kind ?? 'room';
  const locRoom = loc?.kind === 'room' ? loc.roomId : agent.roomId;
  useEffect(() => {
    if (locKind === 'council' && slot >= 0) councilPosition(slot, slotCount, target.current);
    else if (locKind !== 'void') seatPosition(layout, locRoom, agent.seat, target.current);
    if (!placed.current && group.current) {
      group.current.position.copy(target.current);
      placed.current = true;
    }
  }, [locKind, locRoom, slot, slotCount, layout, agent.seat]);

  // Register live position (vote beams) and name-tag anchor (labels).
  useEffect(() => {
    const g = group.current;
    if (!g) return;
    positions.set(id, g.position);
    if (stage === 'alive') anchors.set(id, { pos: g.position, dy: 1.25 });
    else anchors.delete(id);
    return () => {
      if (positions.get(id) === g.position) positions.delete(id);
      if (anchors.get(id)?.pos === g.position) anchors.delete(id);
    };
  }, [id, stage]);

  // Elimination: launch + fall; role-reveal label anchored above the launch point.
  useEffect(() => {
    const revealKey = `reveal:${id}`;
    if (elimAt === undefined) {
      fall.current = null;
      setStage('alive');
      anchors.delete(revealKey);
      return;
    }
    const g = group.current;
    const elapsed = performance.now() - elimAt;
    if (elimOld) {
      fall.current = null;
      anchors.delete(revealKey);
      setStage('gone');
      return;
    }
    const start = g ? g.position.clone() : target.current.clone();
    const dir = new THREE.Vector3(start.x, 0, start.z);
    if (dir.lengthSq() < 0.01) dir.set(1, 0, 0);
    dir.normalize();
    fall.current = { at: elimAt, start, dir };
    if (elapsed < REVEAL_TO_MS) {
      // Reveal floats just past the island edge where the agent fell (not over the council).
      // Concurrent reveals (several eliminations per round in big games) are stacked so they don't overlap.
      const elims = useViewerStore.getState().eliminations;
      let earlier = 0;
      for (const k in elims) {
        const at = elims[k].at;
        if (k !== id && at <= elimAt && at > elimAt - REVEAL_TO_MS) earlier++;
      }
      const edge = Math.max(layout.councilRadius, Math.hypot(start.x, start.z)) + 1.5;
      const pos = new THREE.Vector3(dir.x * edge, start.y, dir.z * edge);
      anchors.set(revealKey, { pos, dy: 1.2 + (earlier % 3) * 1.4, boost: 20000 + earlier });
    }
    if (elapsed >= FALL_MS) {
      setStage('gone');
      return;
    }
    setStage('falling');
    const timer = setTimeout(() => setStage('gone'), FALL_MS - elapsed);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elimAt, elimOld, id]);

  useEffect(() => () => void anchors.delete(`reveal:${id}`), [id]);

  useFrame((state, rawDt) => {
    const g = group.current;
    const b = bob.current;
    if (!g || !b) return;
    const dt = Math.min(rawDt, 0.1);
    const t = state.clock.elapsedTime;

    const f = fall.current;
    if (f) {
      const ft = Math.max(0, (performance.now() - f.at) / 1000);
      g.position.set(
        f.start.x + f.dir.x * 5 * ft,
        f.start.y + 9 * ft - 9 * ft * ft,
        f.start.z + f.dir.z * 5 * ft,
      );
      g.rotation.x = ft * 7;
      g.rotation.z = ft * 4.5;
      g.visible = ft * 1000 < FALL_MS;
      return;
    }

    tmpV.subVectors(target.current, g.position);
    const dist = tmpV.length();
    const moving = dist > 0.03;
    let face: number;
    if (moving) {
      const step = Math.min(dist, WALK_SPEED * dt);
      g.position.addScaledVector(tmpV, step / dist);
      face = Math.atan2(tmpV.x, tmpV.z);
      b.position.y = Math.abs(Math.sin(t * 12 + phase)) * 0.28;
      b.scale.set(1, 1, 1);
    } else {
      face = Math.atan2(-g.position.x, -g.position.z);
      const s = Math.sin(t * 2.2 + phase);
      b.position.y = s * 0.06;
      b.scale.set(1 - s * 0.03, 1 + s * 0.05, 1 - s * 0.03);
    }
    g.rotation.y = lerpAngle(g.rotation.y, face, Math.min(1, dt * 8));

    suspicionColor(suspRef.current, tmpColor);
    ringMat.color.lerp(tmpColor, Math.min(1, dt * 4));
  });

  const hidden = (!agent.alive || locKind === 'void') && elimAt === undefined;
  if (hidden || stage === 'gone') return null;

  const onClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    selectAgent(id);
  };

  return (
    <group ref={group}>
      <group ref={bob}>
        <mesh
          geometry={GEO.blob}
          material={bodyMat}
          onClick={onClick}
          onPointerOver={() => (document.body.style.cursor = 'pointer')}
          onPointerOut={() => (document.body.style.cursor = 'auto')}
        />
        <mesh geometry={GEO.eye} material={MAT.eye} position={[-0.16, 0.1, 0.44]} />
        <mesh geometry={GEO.eye} material={MAT.eye} position={[0.16, 0.1, 0.44]} />
      </group>
      <mesh geometry={GEO.suspicionRing} material={ringMat} rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.52, 0]} />
      {selected && (
        <mesh geometry={GEO.selectRing} material={MAT.select} rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.51, 0]} />
      )}
    </group>
  );
});
