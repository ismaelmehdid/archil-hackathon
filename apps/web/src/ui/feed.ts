'use client';
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { API_ROUTES, type GameEvent, type ReplayFixture } from '@susagent/shared';
import rawFixture from '@susagent/shared/fixtures/replay.json';
import { setConnection, useViewerStore } from '../store';

export const fixture = rawFixture as unknown as ReplayFixture;
export const SERVER_URL = (process.env.NEXT_PUBLIC_SERVER_URL ?? 'http://localhost:4000').replace(/\/$/, '');

interface UiState {
  banner: string | null;
  /** Client-clock start of current phase + server-reported duration (ts-delta based, works for replay too). */
  phaseClock: { startedAt: number; durationMs: number | null } | null;
  /** Bumped on disk_updated per agent so the disk panel refetches. */
  diskVersion: Record<string, number>;
  /** Bump to restart the replay. */
  replayKey: number;
  /** Lobby provisioning progress: agent_ready per agent (and REFEREE_ID). */
  ready: Record<string, { backend: 'archil' | 'memory'; diskId?: string }>;
}

export const useUi = create<UiState>()(() => ({
  banner: null,
  phaseClock: null,
  diskVersion: {},
  replayKey: 0,
  ready: {},
}));

export function dispatch(e: GameEvent) {
  const before = useViewerStore.getState().game;
  useViewerStore.getState().applyEvent(e);
  // only track side-state for events the reducer actually accepted
  if (useViewerStore.getState().game === before) return;
  if (e.type === 'game_created') useUi.setState({ phaseClock: null, diskVersion: {}, ready: {} });
  else if (e.type === 'agent_ready')
    useUi.setState((u) => ({ ready: { ...u.ready, [e.agentId]: { backend: e.backend, diskId: e.diskId } } }));
  if (e.type === 'phase_changed')
    useUi.setState({
      phaseClock: { startedAt: performance.now(), durationMs: e.endsAt != null ? Math.max(0, e.endsAt - e.ts) : null },
    });
  else if (e.type === 'disk_updated')
    useUi.setState((u) => ({ diskVersion: { ...u.diskVersion, [e.agentId]: (u.diskVersion[e.agentId] ?? 0) + 1 } }));
}

export function restartReplay() {
  const vs = useViewerStore.getState();
  if (vs.source !== 'replay') vs.setSource('replay');
  else useUi.setState((u) => ({ replayKey: u.replayKey + 1 }));
}

export async function createGame(agentCount: number): Promise<string | null> {
  try {
    const r = await fetch(SERVER_URL + API_ROUTES.games, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentCount }),
    });
    if (!r.ok) return `Server responded ${r.status}`;
    return null;
  } catch (err) {
    return `Could not reach server: ${String(err)}`;
  }
}

/** Drives the store from SSE (live) or the bundled fixture (replay). Mount once. */
export function useFeed() {
  const source = useViewerStore((s) => s.source);
  const replayKey = useUi((s) => s.replayKey);
  const [urlRead, setUrlRead] = useState(false);

  // URL <-> mode: ?mode=replay|live (also accepts legacy ?replay=1) decides the initial source,
  // and the URL is rewritten on every toggle so the two never disagree.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const m = p.get('mode') ?? (p.get('replay') === '1' ? 'replay' : p.get('live') === '1' ? 'live' : null);
    if (m === 'replay' || m === 'live') useViewerStore.getState().setSource(m);
    setUrlRead(true);
  }, []);
  useEffect(() => {
    if (!urlRead) return;
    const url = new URL(window.location.href);
    url.searchParams.delete('replay');
    url.searchParams.delete('live');
    url.searchParams.delete('r');
    url.searchParams.set('mode', source);
    if (url.href !== window.location.href) window.history.replaceState(null, '', url);
  }, [source, urlRead]);

  useEffect(() => {
    if (!urlRead) return; // wait until the URL decided the initial mode
    let cancelled = false;
    const vs = useViewerStore.getState();

    if (source === 'live') {
      let es: EventSource | null = null;
      let retry: ReturnType<typeof setTimeout> | undefined;
      setConnection('connecting');
      (async () => {
        const ok = await fetch(SERVER_URL + API_ROUTES.health, { signal: AbortSignal.timeout(2500) })
          .then((r) => r.ok)
          .catch(() => false);
        if (cancelled) return;
        if (!ok) {
          useUi.setState({ banner: `Server unreachable at ${SERVER_URL}, so a recorded replay is playing instead.` });
          useViewerStore.getState().setSource('replay');
          return;
        }
        useUi.setState({ banner: null });
        useViewerStore.getState().reset();
        // Always since=0: the reducer drops seq <= lastSeq for the same game and resets on a new gameId,
        // so reconnects (incl. server restarts / new games) converge without gaps.
        const open = () => {
          if (cancelled) return;
          es = new EventSource(SERVER_URL + API_ROUTES.events('current'));
          es.onopen = () => setConnection('live');
          es.onmessage = (m) => {
            try {
              dispatch(JSON.parse(m.data) as GameEvent);
            } catch (err) {
              console.warn('bad SSE event', err);
            }
          };
          es.onerror = () => {
            // Take over from the browser's built-in retry so a restarted server is always picked up.
            es?.close();
            es = null;
            if (cancelled) return;
            setConnection('connecting');
            retry = setTimeout(open, 1500);
          };
        };
        open();
      })();
      return () => {
        cancelled = true;
        clearTimeout(retry);
        es?.close();
      };
    }

    // replay
    vs.reset();
    setConnection('replaying');
    const events = fixture.events;
    let i = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const step = () => {
      if (cancelled) return;
      const e = events[i];
      dispatch(e);
      i++;
      if (i >= events.length) {
        setConnection('ended');
        return;
      }
      const speed = useViewerStore.getState().replaySpeed || 1;
      timer = setTimeout(step, Math.max(0, events[i].ts - e.ts) / speed);
    };
    timer = setTimeout(step, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [source, replayKey, urlRead]);
}
