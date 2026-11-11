'use client';

import { Component, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { useViewerStore } from '../store';
import { computeLayout, seatAngle, type Layout } from './layout';
import { REFEREE_ID } from '@susagent/shared';
import { PALETTE, SPEECH_MS, focus } from './shared';
import { Clouds, Poofs } from './Fx';
import { Clearing } from './Clearing';
import { Forest } from './Forest';
import { Referee } from './Referee';
import { AgentBlob } from './AgentBlob';
import { VoteBeams } from './VoteBeams';
import { LabelLayer, LabelProjector } from './labels';

const FALLBACK_ROOMS = ['r1', 'r2'];

/** Keeps the clearing + referee on screen if a dynamic part of the scene throws; retries on next game. */
class SceneBoundary extends Component<{ children: ReactNode; resetKey: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err: unknown) {
    console.warn('[scene] recovered from error', err);
  }
  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.failed) this.setState({ failed: false });
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

const ZOOM_MS = 1200;

/** Dev-only: exposes the r3f store as window.__susR3f for __sus.bench(). */
function R3fHandle() {
  const get = useThree((s) => s.get);
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    (window as unknown as Record<string, unknown>).__susR3f = { getState: get };
  }, [get]);
  return null;
}

function CameraRig({ ring, council }: { ring: number; council: number }) {
  const camera = useThree((s) => s.camera);
  const aspect = useThree((s) => s.size.width / Math.max(1, s.size.height));
  const controls = useThree((s) => s.controls) as unknown as { target: { set(x: number, y: number, z: number): void }; update(): void } | null;
  const phase = useViewerStore((s) => s.game?.phase);
  const focusCouncil = phase === 'voting' || phase === 'reveal';
  // Re-frame only when the arena size changes (or aspect crosses a band), not on every resize pixel.
  const aspectBand = Math.round(Math.min(1.2, Math.max(0.5, aspect || 1)) * 10) / 10;
  const portrait = 1 / Math.min(1, aspectBand);
  const baseD = ring * 2.5 * portrait;
  const voteD = Math.min(baseD, Math.max(14, council * 2.8) * portrait);
  const anim = useRef<{ from: number; to: number; t0: number } | null>(null);

  useEffect(() => {
    // Fit the whole home ring (plus the forest edge) into the view.
    const d = focusCouncil ? voteD : baseD;
    const az = Math.PI / 4;
    camera.position.set(Math.sin(az) * 0.8, 0.75, Math.cos(az) * 0.8).setLength(d);
    camera.lookAt(0, 0, 0);
    anim.current = null;
    if (controls) {
      controls.target.set(0, 0, 0);
      controls.update();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseD, camera, controls]);

  // Dolly towards the council while voting/reveal, back out afterwards (user can still orbit/zoom).
  useEffect(() => {
    anim.current = { from: camera.position.length(), to: focusCouncil ? voteD : baseD, t0: performance.now() };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusCouncil]);

  useFrame(() => {
    const a = anim.current;
    if (!a) return;
    const k = Math.min(1, (performance.now() - a.t0) / ZOOM_MS);
    const e = k * k * (3 - 2 * k);
    camera.position.setLength(a.from + (a.to - a.from) * e);
    if (k >= 1) anim.current = null;
  });
  return null;
}

function Agents({ layout }: { layout: Layout }) {
  const agents = useViewerStore((s) => s.game?.agents);
  // Council slots follow each agent's home angle, so everyone walks (roughly) straight in to vote.
  const slots = useMemo(() => {
    const m: Record<string, number> = {};
    const alive = (agents ?? []).filter((a) => a.alive);
    const ang = (a: { roomId: string; seat: number }) => {
      const x = seatAngle(layout, a.roomId, a.seat) % (Math.PI * 2);
      return x < 0 ? x + Math.PI * 2 : x;
    };
    alive.sort((a, b) => ang(a) - ang(b)).forEach((a, i) => (m[a.id] = i));
    for (const a of agents ?? []) if (!(a.id in m)) m[a.id] = -1;
    return { m, n: alive.length };
  }, [agents, layout]);
  return (
    <group>
      {(agents ?? []).map((a) => (
        <AgentBlob key={a.id} agent={a} layout={layout} slot={slots.m[a.id] ?? -1} slotCount={slots.n} />
      ))}
    </group>
  );
}

function World() {
  const gameId = useViewerStore((s) => s.game?.gameId ?? 'none');
  const agents = useViewerStore((s) => s.game?.agents);
  const rooms = useViewerStore((s) => s.game?.rooms);
  const roomSize = useViewerStore((s) => s.game?.config.roomSize ?? 6);

  // Stable room set: every room any agent (alive or dead) lives in, plus listed rooms.
  const roomKey = useMemo(() => {
    const ids = new Set<string>();
    for (const a of agents ?? []) ids.add(a.roomId);
    for (const r of rooms ?? []) ids.add(r.id);
    if (ids.size === 0) FALLBACK_ROOMS.forEach((r) => ids.add(r));
    return [...ids].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).join('|');
  }, [agents, rooms]);
  const agentCount = agents?.length || 12;

  const roomIds = useMemo(() => roomKey.split('|'), [roomKey]);
  const layout = useMemo(
    () => computeLayout(roomIds.map((id, index) => ({ id, index })), agentCount, roomSize),
    [roomIds, agentCount, roomSize],
  );

  return (
    <>
      <fog attach="fog" args={[PALETTE.fog, layout.ringRadius * 2.4, layout.ringRadius * 6.5]} />
      <Clouds radius={layout.ringRadius} />
      <CameraRig ring={layout.ringRadius} council={layout.councilRadius} />
      <Forest radius={layout.clearingRadius} />
      <Clearing layout={layout} />
      <Referee />
      <SceneBoundary resetKey={gameId}>
        <group key={gameId}>
          <Agents layout={layout} />
          <VoteBeams />
        </group>
      </SceneBoundary>
      <SceneBoundary resetKey={gameId}>
        <Poofs />
      </SceneBoundary>
    </>
  );
}

/** Dev-only: window.__sus.play(speed) streams the replay fixture through the store (scene testing). */
function useDevHook() {
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    const w = window as unknown as Record<string, unknown>;
    w.__sus = {
      store: useViewerStore,
      /** Synchronous frame benchmark (works even when the tab is hidden): avg/max ms per full frame. */
      bench(n = 120) {
        const st = (w.__susR3f as { getState(): { advance(t: number, run?: boolean): void; gl: { getContext(): WebGLRenderingContext } } } | undefined)?.getState();
        if (!st) return 'no r3f';
        const gl = st.gl.getContext();
        const px = new Uint8Array(4);
        let max = 0;
        const t0 = performance.now();
        for (let i = 0; i < n; i++) {
          const a = performance.now();
          st.advance(a, true);
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); // force GPU sync
          max = Math.max(max, performance.now() - a);
        }
        const avg = (performance.now() - t0) / n;
        return { avgMs: +avg.toFixed(2), maxMs: +max.toFixed(2), fpsEquiv: +(1000 / avg).toFixed(0) };
      },
      async play(speed = 4, fromSeq = 0, untilSeq = Infinity) {
        const mod = await import('@susagent/shared/fixtures/replay.json');
        const fx = (mod as unknown as { default: { events: import('@susagent/shared').GameEvent[] } }).default;
        const st = useViewerStore.getState();
        st.reset();
        let prev = 0;
        for (const e of fx.events) {
          if (e.seq > untilSeq) break;
          if (e.seq < fromSeq) {
            useViewerStore.getState().applyEvent(e);
            prev = e.ts;
            continue;
          }
          await new Promise((r) => setTimeout(r, Math.max(0, (e.ts - prev) / speed)));
          prev = e.ts;
          useViewerStore.getState().applyEvent(e);
        }
      },
    };
  }, []);
}

/** Tracks the newest speaker so every blob (and the referee) can turn and look at them. */
function useSpeakerFocus() {
  useEffect(() => {
    const pick = (speech: ReturnType<typeof useViewerStore.getState>['speech']) => {
      const now = performance.now();
      let best: string | null = null;
      let score = -Infinity;
      for (const id in speech) {
        const b = speech[id];
        if (now - b.at >= SPEECH_MS) continue;
        // Agents win over the referee when both talk at once.
        const sc = b.at - (id === REFEREE_ID ? 400 : 0);
        if (sc > score) {
          score = sc;
          best = id;
        }
      }
      focus.id = best;
      focus.at = best ? speech[best].at : 0;
    };
    pick(useViewerStore.getState().speech);
    return useViewerStore.subscribe((s, prev) => {
      if (s.speech !== prev.speech) pick(s.speech);
    });
  }, []);
}

export default function Arena() {
  useDevHook();
  useSpeakerFocus();
  return (
    <div className="sky" style={{ position: 'absolute', inset: 0 }}>
      <Canvas
        camera={{ position: [0, 30, 44], fov: 50, near: 0.1, far: 400 }}
        dpr={[1, 1.75]}
        gl={{ antialias: true, alpha: true }}
        flat
      >
        <hemisphereLight args={['#ffffff', '#c7b6e8', 0.85]} />
        <ambientLight intensity={0.2} />
        <directionalLight position={[20, 35, 15]} intensity={0.95} color="#fff4e0" />
        <World />
        <LabelProjector />
        <R3fHandle />
        <OrbitControls
          makeDefault
          autoRotate
          autoRotateSpeed={0.35}
          enableDamping
          maxPolarAngle={1.35}
          minDistance={6}
          maxDistance={150}
        />
      </Canvas>
      <LabelLayer />
    </div>
  );
}
