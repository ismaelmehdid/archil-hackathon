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
/* Visual styling lives in globals.css (.sus-*) so bubbles can have CSS tails + keyframes. */

const anchorBase: CSSProperties = {
  position: 'absolute',
  left: 0,
  top: 0,
  display: 'none',
  willChange: 'transform',
  pointerEvents: 'none',
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

/** Hard-truncated so bubbles stay short and readable. */
function Bubble({ text, wide }: { text: string; wide?: boolean }) {
  return <div className={wide ? 'sus-bubble sus-bubble-ref' : 'sus-bubble'}>{truncate(text, wide ? 64 : 48)}</div>;
}

/** True for `ms` after `at` (re-renders once when it flips back). */
function useFreshAt(at: number | undefined, ms: number): boolean {
  const [, force] = useState(0);
  const remaining = at === undefined ? 0 : ms - (performance.now() - at);
  const fresh = remaining > 0;
  useEffect(() => {
    if (!fresh) return;
    const t = setTimeout(() => force((x) => x + 1), remaining + 30);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at, fresh]);
  return fresh;
}

let gifFailed = false;

function VotedBadge() {
  const [failed, setFailed] = useState(gifFailed);
  if (failed) return <div className="sus-voted">VOTED!</div>;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/voted.gif"
      width={40}
      alt="voted"
      className="sus-voted-gif"
      onError={() => {
        gifFailed = true;
        setFailed(true);
      }}
    />
  );
}

const MAX_BUBBLES = 3;
/** How long the VOTED badge pops after a vote; afterwards the name tag just shows a small check. */
const VOTED_POP_MS = 2500;

/** rank: 0 = newest speaker ... MAX_BUBBLES-1; -1 = bubble suppressed (too many talking at once). */
function AgentLabel({ agent, rank, topVotes }: { agent: AgentPublic; rank: number; topVotes: number }) {
  const id = agent.id;
  const speech = useFreshSpeech(useViewerStore((s) => s.speech[id]));
  const votedAt = useViewerStore((s) => s.liveVotes[id]?.at);
  const votesFor = useViewerStore((s) => s.liveTally[id] ?? 0);
  const selected = useViewerStore((s) => s.selectedAgentId === id);
  const justVoted = useFreshAt(votedAt, VOTED_POP_MS);
  const showBubble = !!speech && (rank >= 0 || selected);
  const lead = votesFor > 0 && votesFor === topVotes;
  return (
    <div ref={useLabelRef(id)} style={anchorBase}>
      <div className="sus-stack">
        {showBubble && (
          <div key={speech.id} className="sus-bubble-wrap">
            <Bubble text={speech.text} />
          </div>
        )}
        {votesFor > 0 && (
          <div key={votesFor} className={lead ? 'sus-count lead' : 'sus-count'}>
            {votesFor} {votesFor === 1 ? 'vote' : 'votes'}
          </div>
        )}
        {justVoted && <VotedBadge />}
        <div className={selected ? 'sus-tag selected' : 'sus-tag'}>
          <span className="sus-tag-dot" style={{ background: agent.color }} />
          {agent.name}
          {votedAt !== undefined && !justVoted && <span className="sus-tag-check" title="has voted">✓</span>}
        </div>
      </div>
    </div>
  );
}

function RefereeLabel() {
  const fresh = useFreshSpeech(useViewerStore((s) => s.speech[REFEREE_ID]));
  // The question itself already sits in the caption + side panel; only show the referee's other announcements.
  const isQuestion = useViewerStore((s) => !!fresh && !!s.game?.questions.some((q) => q.text === fresh.text));
  const speech = isQuestion ? null : fresh;
  return (
    <div ref={useLabelRef(REFEREE_ID)} style={anchorBase}>
      <div className="sus-stack">
        {speech && (
          <div key={speech.id} className="sus-bubble-wrap">
            <Bubble text={speech.text} wide />
          </div>
        )}
        <div className="sus-tag sus-tag-ref">Referee</div>
      </div>
    </div>
  );
}

export const REVEAL_FROM_MS = 900;
export const REVEAL_TO_MS = 4800;

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
        <div className={imp ? 'sus-reveal imp' : 'sus-reveal crew'}>
          <div className="sus-reveal-who">{name} was</div>
          <div className="sus-reveal-role">{imp ? 'IMPOSTOR!' : 'CREW'}</div>
          <div className="sus-reveal-quip">{imp ? 'nice catch!' : 'oops... innocent'}</div>
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
  // Highest live vote count, so the current front-runner's count bubble can be emphasised.
  const topVotes = useViewerStore((s) => {
    let m = 0;
    for (const k in s.liveTally) m = Math.max(m, s.liveTally[k]);
    return m;
  });
  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none', zIndex: 1 }}>
      <RefereeLabel />
      <div key={gameId}>
        {(agents ?? []).map((a) => (
          <AgentLabel key={a.id} agent={a} rank={ranks[a.id] ?? -1} topVotes={topVotes} />
        ))}
        {Object.entries(eliminations).map(([id, fx]) => (
          <RevealLabel key={id} id={id} name={names[id] ?? id} fx={fx} />
        ))}
      </div>
    </div>
  );
}
