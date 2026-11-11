'use client';

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { REFEREE_ID } from '@susagent/shared';
import { useViewerStore } from '../store';
import { GEO, MAT, REF_POS, SPEECH_MS, anchors, focus, positions, spawnPoof } from './shared';

const BONK_MS = 650;
const TOOT_MS = 900;
const BASE_Y = 1.15;
const BONK_AT = new THREE.Vector3(1.55, 0.25, 0.4);

/**
 * Big cream blob in a silly party hat, with a whistle and a gavel.
 * Toots the whistle when voting starts; bonks the gavel when someone gets launched.
 */
export function Referee() {
  const root = useRef<THREE.Group>(null);
  const bob = useRef<THREE.Group>(null);
  const eyes = useRef<THREE.Mesh>(null);
  const gavel = useRef<THREE.Group>(null);
  const whistle = useRef<THREE.Mesh>(null);
  const mouth = useRef<THREE.Mesh>(null);
  const fx = useRef({ bonkAt: -1e9, tootAt: -1e9, poofed: true, speakAt: -1e9 });

  useEffect(() => {
    anchors.set(REFEREE_ID, { pos: REF_POS, dy: 3.6, boost: 100 });
    return () => void anchors.delete(REFEREE_ID);
  }, []);

  // Event triggers without re-rendering: subscribe straight to the store.
  useEffect(() => {
    let elimCount = Object.keys(useViewerStore.getState().eliminations).length;
    return useViewerStore.subscribe((s, prev) => {
      const n = Object.keys(s.eliminations).length;
      if (n > elimCount) {
        fx.current.bonkAt = performance.now();
        fx.current.poofed = false;
      }
      elimCount = n;
      if (s.game?.phase === 'voting' && prev.game?.phase !== 'voting') fx.current.tootAt = performance.now();
      const sp = s.speech[REFEREE_ID];
      if (sp && sp !== prev.speech[REFEREE_ID]) fx.current.speakAt = sp.at;
    });
  }, []);

  useFrame((state, rawDt) => {
    const r = root.current;
    const b = bob.current;
    const gv = gavel.current;
    const wh = whistle.current;
    const e = eyes.current;
    const m = mouth.current;
    if (!r || !b || !gv || !wh || !e || !m) return;
    const dt = Math.min(rawDt, 0.1);
    const t = state.clock.elapsedTime;
    const now = performance.now();
    const f = fx.current;

    // Turn towards whoever is talking, else idle sway.
    let face = Math.sin(t * 0.4) * 0.6;
    const fid = focus.id;
    if (fid && fid !== REFEREE_ID && now - focus.at < SPEECH_MS) {
      const p = positions.get(fid);
      if (p) face = Math.atan2(p.x, p.z);
    }
    let d = face - r.rotation.y;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    r.rotation.y += d * Math.min(1, dt * 3);

    // Gavel: wind up, slam, wobble back.
    const bk = (now - f.bonkAt) / BONK_MS;
    let swing = Math.sin(t * 1.1) * 0.08;
    let squash = 0;
    if (bk >= 0 && bk < 1) {
      if (bk < 0.25) swing = 0.7 * (bk / 0.25);
      else if (bk < 0.38) swing = 0.7 - 2.3 * ((bk - 0.25) / 0.13);
      else swing = -1.6 * (1 - (bk - 0.38) / 0.62) + Math.sin(bk * 40) * 0.1 * (1 - bk);
      if (bk > 0.36) squash = Math.sin(Math.min(1, (bk - 0.36) / 0.4) * Math.PI) * 0.16;
      if (bk > 0.38 && !f.poofed) {
        f.poofed = true;
        tmpPos.copy(BONK_AT).applyAxisAngle(UP, r.rotation.y);
        spawnPoof(tmpPos, 0.55);
      }
    }
    gv.rotation.z = swing;

    // Whistle toot: puff up + little hop.
    const tk = (now - f.tootAt) / TOOT_MS;
    let hop = 0;
    let toot = 1;
    if (tk >= 0 && tk < 1) {
      toot = 1 + Math.sin(tk * Math.PI * 6) * 0.35 * (1 - tk);
      hop = Math.sin(Math.min(1, tk * 2) * Math.PI) * 0.45;
    }
    wh.scale.set(toot, 1, toot);

    b.position.y = BASE_Y + Math.sin(t * 1.6) * 0.08 + hop;
    b.scale.set(1 + squash * 0.6, 1 - squash, 1 + squash * 0.6);

    const blink = (t % 3.3) < 0.14 ? 0.12 : 1;
    const startled = bk > 0.36 && bk < 0.8 ? 1.35 : 1;
    e.scale.set(startled, blink * startled, startled);

    const talking = now - f.speakAt < SPEECH_MS;
    m.visible = talking;
    if (talking) m.scale.set(2.2, 0.5 + 1.2 * Math.abs(Math.sin(t * 14)), 1);
  });

  return (
    <group ref={root}>
      <mesh geometry={GEO.hex} material={MAT.gold} scale={[1.25, 0.22, 1.25]} position={[0, 0.11, 0]} />
      <group ref={bob} position={[0, BASE_Y, 0]}>
        <mesh geometry={GEO.blob} material={MAT.referee} scale={1.9} />
        <mesh ref={eyes} geometry={GEO.eyes} material={MAT.eye} scale={1.8} position={[0, 0.22, 0.82]} />
        <mesh geometry={GEO.cheeks} material={MAT.cheek} scale={1.9} />
        <mesh ref={mouth} geometry={GEO.mouth} material={MAT.mouth} position={[0.32, -0.2, 0.86]} visible={false} />
        {/* whistle */}
        <mesh
          ref={whistle}
          geometry={GEO.whistle}
          material={MAT.gold}
          position={[0, -0.22, 0.98]}
          rotation={[Math.PI / 2, 0, 0]}
        />
        {/* party hat, tilted for comedy */}
        <group position={[0.15, 0.8, 0]} rotation={[0, 0, -0.22]}>
          <mesh geometry={GEO.hatBand} material={MAT.candyYellow} position={[0, 0.02, 0]} scale={1.3} />
          <mesh geometry={GEO.hat} material={MAT.hat} position={[0, 0.55, 0]} />
          <mesh geometry={GEO.ball} material={MAT.candyPink} position={[0, 1.1, 0]} scale={0.17} />
        </group>
        {/* gavel, pivoting at the "hand" */}
        <group ref={gavel} position={[0.95, 0.05, 0.4]}>
          <mesh geometry={GEO.stick} material={MAT.trunk} position={[0.35, 0.35, 0]} rotation={[0, 0, -0.8]} scale={[1, 1, 1]} />
          <mesh geometry={GEO.gavelHead} material={MAT.gavelHead} position={[0.72, 0.72, 0]} rotation={[0, 0, 0.77]} />
        </group>
      </group>
    </group>
  );
}

const UP = new THREE.Vector3(0, 1, 0);
const tmpPos = new THREE.Vector3();
