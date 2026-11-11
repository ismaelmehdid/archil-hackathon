'use client';

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { REFEREE_ID, type AgentPublic } from '@susagent/shared';
import { useViewerStore } from '../store';
import { councilPosition, seatPosition, type Layout } from './layout';
import { GEO, MAT, REF_POS, SPEECH_MS, anchors, focus, positions, spawnPoof } from './shared';
import { lowPoly } from './lowpoly';
import { REVEAL_TO_MS } from './labels';

const GREEN = new THREE.Color('#4fdc8f');
const ORANGE = new THREE.Color('#ffb02e');
const RED = new THREE.Color('#ff4f5e');
const tmpColor = new THREE.Color();
const tmpV = new THREE.Vector3();

const FALL_MS = 3200;
const WALK_SPEED = 6.5;
const HOPS_PER_S = 3.2;
const LOOK_DIST_SQ = 16 * 16;
const EYE_Y = 0.1;
const EYE_Z = 0.44;

function suspicionColor(s: number, out: THREE.Color) {
  const v = Math.min(1, Math.max(0, s));
  if (v < 0.5) out.copy(GREEN).lerp(ORANGE, v * 2);
  else out.copy(ORANGE).lerp(RED, (v - 0.5) * 2);
}

function wrapAngle(d: number) {
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function lerpAngle(a: number, b: number, k: number) {
  return a + wrapAngle(b - a) * k;
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
  const speakAt = useViewerStore((s) => s.speech[id]?.at ?? -1e9);
  // Eliminated in an earlier round (e.g. SSE catch-up on connect): no fall/reveal, just gone.
  const elimOld = useViewerStore((s) => {
    const g = s.game;
    const e = g?.eliminated.find((x) => x.agentId === id);
    return !!g && !!e && e.round < g.round;
  });
  const selectAgent = useViewerStore((s) => s.selectAgent);

  const group = useRef<THREE.Group>(null);
  const bob = useRef<THREE.Group>(null);
  const eyes = useRef<THREE.Mesh>(null);
  const brows = useRef<THREE.Mesh>(null);
  const mouth = useRef<THREE.Mesh>(null);
  const selRing = useRef<THREE.Mesh>(null);
  const target = useRef(new THREE.Vector3());
  const placed = useRef(false);
  const suspRef = useRef(suspicion);
  suspRef.current = suspicion;
  const speakRef = useRef(speakAt);
  speakRef.current = speakAt;
  // Per-agent animation state (mutable, no allocations per frame).
  const anim = useRef({ hop: 0, moving: false, landAt: -10, look: 0 });
  const phase = useMemo(() => (parseInt(id.replace(/\D/g, ''), 10) || 0) * 1.37, [id]);
  const blinkEvery = useMemo(() => 2.6 + ((phase * 7.3) % 2.4), [phase]);
  const fall = useRef<{ at: number; start: THREE.Vector3; dir: THREE.Vector3; poofed: boolean } | null>(null);
  const [stage, setStage] = useState<Stage>('alive');

  const bodyMat = useMemo(
    () => lowPoly(new THREE.MeshStandardMaterial({ color: agent.color, flatShading: true, roughness: 0.75 })),
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
    // While being yeeted, vote arcs (and lookers) stay pinned to the launch spot instead of chasing the blob into the sky.
    const p = stage === 'falling' && fall.current ? fall.current.start : g.position;
    positions.set(id, p);
    if (stage === 'alive') anchors.set(id, { pos: g.position, dy: 1.3 });
    else anchors.delete(id);
    return () => {
      if (positions.get(id) === p) positions.delete(id);
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
    fall.current = { at: elimAt, start, dir, poofed: elapsed >= 3000 };
    if (elapsed < 400) spawnPoof(start, 1.1, elimAt);
    if (elapsed < REVEAL_TO_MS) {
      // Reveal floats just outside where the agent was launched from (not over the council).
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
    const e = eyes.current;
    const br = brows.current;
    const m = mouth.current;
    if (!g || !b || !e || !br || !m) return;
    const dt = Math.min(rawDt, 0.1);
    const t = state.clock.elapsedTime;
    const now = performance.now();
    const st = anim.current;

    const f = fall.current;
    if (f) {
      // Cartoon yeet: launched up and away over the forest, wild spin, startled face, poof in the sky.
      const ft = Math.max(0, (now - f.at) / 1000);
      g.position.set(
        f.start.x + f.dir.x * 8 * ft,
        f.start.y + 11 * ft - 2.2 * ft * ft,
        f.start.z + f.dir.z * 8 * ft,
      );
      g.rotation.set(ft * 5, ft * 14, ft * 3);
      const gone = Math.min(1, Math.max(0, (ft - 2.5) / 0.5));
      g.scale.setScalar(1 - gone * 0.95);
      if (gone >= 1 && !f.poofed) {
        f.poofed = true;
        spawnPoof(g.position, 1.4);
      }
      const wob = 1 + Math.sin(ft * 30) * 0.12 * Math.max(0, 1 - ft);
      b.position.y = 0;
      b.scale.set(wob, 2 - wob, wob);
      e.scale.set(1.55, 1.55, 1.55);
      e.position.set(0, EYE_Y + 0.03, EYE_Z);
      m.visible = true;
      m.scale.set(1.1, 1.5, 0.6);
      br.visible = true;
      br.position.y = 0.3;
      g.visible = ft * 1000 < FALL_MS;
      return;
    }

    tmpV.subVectors(target.current, g.position);
    const dist = tmpV.length();
    const moving = dist > 0.03;
    if (st.moving && !moving) st.landAt = t; // boing!
    st.moving = moving;

    // Who to look at: the newest speaker nearby (heads turn together, eyes lead the body).
    let lookX = 0;
    let lookZ = 0;
    let haveLook = false;
    const fid = focus.id;
    if (fid && fid !== id && now - focus.at < SPEECH_MS) {
      const p = fid === REFEREE_ID ? REF_POS : positions.get(fid);
      if (p) {
        const dx = p.x - g.position.x;
        const dz = p.z - g.position.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > 0.01 && d2 < LOOK_DIST_SQ) {
          lookX = dx;
          lookZ = dz;
          haveLook = true;
        }
      }
    }

    let face: number;
    let sx = 1;
    let sy = 1;
    if (moving) {
      // Hop along with squash & stretch.
      const step = Math.min(dist, WALK_SPEED * dt);
      g.position.addScaledVector(tmpV, step / dist);
      face = Math.atan2(tmpV.x, tmpV.z);
      st.hop += dt * HOPS_PER_S;
      const p = st.hop % 1;
      const arc = Math.sin(Math.PI * p);
      b.position.y = arc * 0.42;
      sy = 0.84 + arc * 0.32;
      sx = 1 / Math.sqrt(sy);
      b.rotation.x = 0.12;
      b.rotation.z = 0;
    } else {
      st.hop = 0;
      face = haveLook ? Math.atan2(lookX, lookZ) : Math.atan2(-g.position.x, -g.position.z);
      const s = Math.sin(t * 2.2 + phase);
      b.position.y = s * 0.04;
      sy = 1 + s * 0.04;
      sx = 1 - s * 0.025;
      // Landing boing: a damped spring on the squash.
      const k = t - st.landAt;
      if (k < 0.9) {
        const w = Math.cos(k * 20) * Math.exp(-k * 5.5) * 0.24;
        sy -= w;
        sx += w * 0.6;
      }
      b.rotation.x *= 0.85;
      b.rotation.z = Math.sin(t * 1.3 + phase) * 0.05;
    }
    b.scale.set(sx, sy, sx);
    g.scale.setScalar(1);
    g.rotation.x = 0;
    g.rotation.z = 0;
    g.rotation.y = lerpAngle(g.rotation.y, face, Math.min(1, dt * 7));

    // Eyes: blink + dart towards whatever the body is turning to.
    const rel = wrapAngle(face - g.rotation.y);
    st.look += (Math.max(-1, Math.min(1, rel * 1.5)) - st.look) * Math.min(1, dt * 12);
    const bt = (t + phase) % blinkEvery;
    const blink = bt < 0.13 ? 0.12 : 1;
    const susp = suspRef.current;
    e.position.set(st.look * 0.065, EYE_Y + (fid === REFEREE_ID && haveLook ? 0.025 : 0), EYE_Z);
    e.scale.set(1, blink, 1);

    // Worried brows when suspicion is high (with a nervous twitch).
    const worried = susp > 0.55;
    br.visible = worried;
    if (worried) br.position.set(st.look * 0.05, 0.24 + Math.sin(t * 9 + phase) * 0.012, 0.42);

    // Mouth flaps while this agent's speech bubble is up.
    const talking = now - speakRef.current < SPEECH_MS;
    m.visible = talking;
    if (talking) m.scale.set(1.2, 0.35 + 0.75 * Math.abs(Math.sin(t * 16 + phase)), 0.6);

    const sr = selRing.current;
    if (sr) {
      sr.rotation.z += dt * 1.5;
      const ps = 1 + Math.sin(t * 5) * 0.05;
      sr.scale.set(ps, ps, ps);
    }

    suspicionColor(susp, tmpColor);
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
        <mesh ref={eyes} geometry={GEO.eyes} material={MAT.eye} position={[0, EYE_Y, EYE_Z]} />
        <mesh geometry={GEO.cheeks} material={MAT.cheek} />
        <mesh ref={brows} geometry={GEO.brows} material={MAT.eye} position={[0, 0.24, 0.42]} visible={false} />
        <mesh ref={mouth} geometry={GEO.mouth} material={MAT.mouth} position={[0, -0.12, 0.45]} visible={false} />
      </group>
      <mesh geometry={GEO.suspicionRing} material={ringMat} rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.52, 0]} />
      {selected && (
        <mesh
          ref={selRing}
          geometry={GEO.selectRing}
          material={MAT.select}
          rotation={[-Math.PI / 2, 0, 0]}
          position={[0, -0.51, 0]}
        />
      )}
    </group>
  );
});
