'use client';

/**
 * Screen-space labels (name tags, speech bubbles, VOTED gif, role reveal).
 * Rendered as plain DOM in ONE overlay (same React root as the page, no drei <Html> roots),
 * positioned every frame by <LabelProjector/> inside the Canvas.
 */

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { REFEREE_ID, type AgentPublic, type EliminationFx, type SpeechBubble } from '@susagent/shared';
import { useViewerStore } from '../store';
import { SPEECH_MS, anchors, labelEls, truncate } from './shared';

/* ------------------------------ projector (inside Canvas) ------------------------------ */

export function LabelProjector() {
  const v = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ camera, size }) => {
    labelEls.forEach((el, key) => {
      const a = anchors.get(key);
      if (!a) {
        if (el.style.display !== 'none') el.style.display = 'none';
        return;
      }
      v.copy(a.pos);
      v.y += a.dy;
      const dist = camera.position.distanceTo(v);
      v.project(camera);
      if (v.z > 1 || v.z < -1) {
        if (el.style.display !== 'none') el.style.display = 'none';
        return;
      }
      if (el.style.display === 'none') el.style.display = '';
      const x = ((v.x + 1) / 2) * size.width;
      const y = ((1 - v.y) / 2) * size.height;
      el.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0)`;
      el.style.zIndex = String(Math.max(1, 10000 - Math.round(dist * 20)) + (a.boost ?? 0));
    });
  });
  return null;
}

/* ------------------------------ styles ------------------------------ */

const anchorBase: CSSProperties = {
  position: 'absolute',
  left: 0,
  top: 0,
  display: 'none',
  willChange: 'transform',
  pointerEvents: 'none',
};

const stackStyle: CSSProperties = {
  transform: 'translate(-50%, -100%)',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 3,
  userSelect: 'none',
  whiteSpace: 'nowrap',
  fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
};

function tagStyle(color: string, selected: boolean, gold = false): CSSProperties {
  return {
    fontSize: 11,
    fontWeight: 600,
    lineHeight: '14px',
    padding: '1px 6px',
    borderRadius: 8,
    color: gold ? '#2a1d00' : '#fff',
    background: gold ? '#e6b43c' : 'rgba(15,20,35,0.72)',
    borderBottom: `2px solid ${color}`,
    outline: selected ? '2px solid #fff' : 'none',
  };
}

const bubbleStyle: CSSProperties = {
  maxWidth: 180,
  width: 'max-content',
  whiteSpace: 'normal',
  fontSize: 11,
  lineHeight: '14px',
  padding: '4px 8px',
  borderRadius: 10,
  background: '#ffffff',
  color: '#1a1a1a',
  boxShadow: '0 2px 6px rgba(0,0,0,0.35)',
  textAlign: 'center',
};

/* ------------------------------ pieces ------------------------------ */

/** Returns the bubble while it is fresh (~3 s after `at`), else null. Re-renders once when it expires. */
function useFreshSpeech(b: SpeechBubble | undefined): SpeechBubble | null {
  const [, force] = useState(0);
  const remaining = b ? SPEECH_MS - (performance.now() - b.at) : 0;
  const fresh = remaining > 0;
  useEffect(() => {
    if (!b || !fresh) return;
    const t = setTimeout(() => force((x) => x + 1), remaining + 30);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [b, fresh]);
  return b && fresh ? b : null;
}

function useLabelRef(key: string) {
  return useCallback(
    (el: HTMLDivElement | null) => {
      if (el) labelEls.set(key, el);
      else labelEls.delete(key);
    },
    [key],
  );
}

function Bubble({ text, wide }: { text: string; wide?: boolean }) {
  return (
    <div style={wide ? { ...bubbleStyle, maxWidth: 260, fontWeight: 600 } : bubbleStyle}>
      {truncate(text, wide ? 90 : 60)}
    </div>
  );
}

let gifFailed = false;

function VotedBadge() {
  const [failed, setFailed] = useState(gifFailed);
  if (failed) {
    return (
      <div
        style={{
          fontSize: 10,
          fontWeight: 800,
          letterSpacing: 0.5,
          padding: '1px 6px',
          borderRadius: 8,
          background: '#ef476f',
          color: '#fff',
        }}
      >
        VOTED
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/voted.gif"
      width={48}
      alt="voted"
      style={{ display: 'block', borderRadius: 6 }}
      onError={() => {
        gifFailed = true;
        setFailed(true);
      }}
    />
  );
}

const MAX_BUBBLES = 6;

/** rank: 0 = newest speaker ... MAX_BUBBLES-1; -1 = bubble suppressed (too many talking at once). */
function AgentLabel({ agent, rank }: { agent: AgentPublic; rank: number }) {
  const id = agent.id;
  const speech = useFreshSpeech(useViewerStore((s) => s.speech[id]));
  const voted = useViewerStore((s) => !!s.liveVotes[id]);
  const selected = useViewerStore((s) => s.selectedAgentId === id);
  const showBubble = !!speech && (rank >= 0 || selected);
  const small = rank >= 2 && !selected;
  return (
    <div ref={useLabelRef(id)} style={anchorBase}>
      <div style={stackStyle}>
        {showBubble && (
          <div style={small ? { transform: 'scale(0.82)', transformOrigin: 'bottom center', opacity: 0.85 } : undefined}>
            <Bubble text={speech.text} />
          </div>
        )}
        {voted && <VotedBadge />}
        <div style={tagStyle(agent.color, selected)}>{agent.name}</div>
      </div>
    </div>
  );
}

function RefereeLabel() {
  const speech = useFreshSpeech(useViewerStore((s) => s.speech[REFEREE_ID]));
  return (
    <div ref={useLabelRef(REFEREE_ID)} style={anchorBase}>
      <div style={stackStyle}>
        {speech && <Bubble text={speech.text} wide />}
        <div style={tagStyle('#e6b43c', false, true)}>Referee</div>
      </div>
    </div>
  );
}

export const REVEAL_FROM_MS = 900;
export const REVEAL_TO_MS = 4800;

const POP_CSS =
  "@keyframes susPop{0%{transform:scale(0.2);opacity:0}70%{transform:scale(1.25);opacity:1}100%{transform:scale(1)}}@keyframes susFade{to{opacity:0;transform:translateY(-12px)}}";

function RevealLabel({ id, name, fx }: { id: string; name: string; fx: EliminationFx }) {
  const [show, setShow] = useState(false);
  const ref = useLabelRef(`reveal:${id}`);
  useEffect(() => {
    const elapsed = performance.now() - fx.at;
    if (elapsed >= REVEAL_TO_MS) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    if (elapsed >= REVEAL_FROM_MS) setShow(true);
    else timers.push(setTimeout(() => setShow(true), REVEAL_FROM_MS - elapsed));
    timers.push(setTimeout(() => setShow(false), REVEAL_TO_MS - elapsed));
    return () => timers.forEach(clearTimeout);
  }, [fx.at]);
  if (!show) return null;
  const imp = fx.role === 'impostor';
  return (
    <div ref={ref} style={anchorBase}>
      <div style={{ transform: 'translate(-50%, -100%)' }}>
        <div
          style={{
            fontFamily: 'system-ui, sans-serif',
            textAlign: 'center',
            padding: '4px 12px',
            borderRadius: 10,
            color: '#fff',
            background: imp ? '#d62828' : '#2a9d8f',
            boxShadow: `0 0 18px ${imp ? '#ff4d4d' : '#4dd6c4'}`,
            animation: "susPop 350ms ease-out, susFade 700ms ease-in 3200ms forwards",
            whiteSpace: 'nowrap',
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 600, opacity: 0.9 }}>{name} was</div>
          <div style={{ fontSize: 18, fontWeight: 900, letterSpacing: 2 }}>{imp ? 'IMPOSTOR' : 'CREW'}</div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ overlay (outside Canvas) ------------------------------ */

export function LabelLayer() {
  const gameId = useViewerStore((s) => s.game?.gameId ?? 'none');
  const agents = useViewerStore((s) => s.game?.agents);
  const eliminations = useViewerStore((s) => s.eliminations);
  const speech = useViewerStore((s) => s.speech);
  const names = useMemo(() => {
    const m: Record<string, string> = {};
    for (const a of agents ?? []) m[a.id] = a.name;
    return m;
  }, [agents]);
  // Newest MAX_BUBBLES fresh speakers get a bubble; the rest are suppressed to avoid a wall of text.
  const ranks = useMemo(() => {
    const now = performance.now();
    const fresh = Object.entries(speech)
      .filter(([id, b]) => id !== REFEREE_ID && now - b.at < SPEECH_MS)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, MAX_BUBBLES);
    const r: Record<string, number> = {};
    fresh.forEach(([id], i) => (r[id] = i));
    return r;
  }, [speech]);
  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none', zIndex: 1 }}>
      <style>{POP_CSS}</style>
      <RefereeLabel />
      <div key={gameId}>
        {(agents ?? []).map((a) => (
          <AgentLabel key={a.id} agent={a} rank={ranks[a.id] ?? -1} />
        ))}
        {Object.entries(eliminations).map(([id, fx]) => (
          <RevealLabel key={id} id={id} name={names[id] ?? id} fx={fx} />
        ))}
      </div>
    </div>
  );
}
