'use client';
import { useState } from 'react';
import { MAX_AGENTS, MIN_AGENTS } from '@susagent/shared';
import { useViewerStore } from '../store';
import { createGame, restartReplay, useUi } from './feed';
import { impostorTotal, useNow } from './common';

function fmt(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function PhaseTimer() {
  const clock = useUi((s) => s.phaseClock);
  const source = useViewerStore((s) => s.source);
  const speed = useViewerStore((s) => s.replaySpeed);
  const now = useNow(250);
  if (!clock) return null;
  const elapsed = (now - clock.startedAt) * (source === 'replay' ? speed : 1);
  if (clock.durationMs != null)
    return (
      <span className="timer" title="time left in phase">
        {fmt(clock.durationMs - elapsed)}
      </span>
    );
  return (
    <span className="timer" title="time in phase">
      +{fmt(elapsed)}
    </span>
  );
}

export default function Header() {
  const game = useViewerStore((s) => s.game);
  const source = useViewerStore((s) => s.source);
  const connection = useViewerStore((s) => s.connection);
  const godMode = useViewerStore((s) => s.godMode);
  const setGodMode = useViewerStore((s) => s.setGodMode);
  const setSource = useViewerStore((s) => s.setSource);
  const replaySpeed = useViewerStore((s) => s.replaySpeed);
  const setReplaySpeed = useViewerStore((s) => s.setReplaySpeed);
  const [count, setCount] = useState(12);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const alive = game?.agents.filter((a) => a.alive) ?? [];
  const impTotal = game ? impostorTotal(game.config.agentCount, game.config.impostorRatio) : 0;
  const impOut = game?.eliminated.filter((e) => e.role === 'impostor').length ?? 0;
  const impAlive =
    godMode && game && Object.keys(game.roles).length
      ? alive.filter((a) => game.roles[a.id] === 'impostor').length
      : Math.max(0, impTotal - impOut);
  const crewAlive = alive.length - impAlive;

  const onNewGame = async () => {
    setBusy(true);
    setErr(null);
    const n = Math.min(MAX_AGENTS, Math.max(MIN_AGENTS, Math.round(count) || 12));
    setCount(n);
    const e = await createGame(n);
    setBusy(false);
    setErr(e);
  };

  return (
    <header className="header">
      <div className="brand">
        <span className="brand-blob" aria-hidden />
        Sus<span>Agent</span>
      </div>
      {game ? (
        <>
          <span className="round">
            Round <b>{game.round}</b>/{game.config.rounds}
          </span>
          <PhaseTimer />
          <span className="counts" title={`${crewAlive} crew + ${impAlive} impostor${impAlive === 1 ? '' : 's'} still playing`}>
            <b>{alive.length}</b> players left · <b className="c-imp">{impAlive}</b> impostor{impAlive === 1 ? '' : 's'} hidden among them
          </span>
        </>
      ) : (
        <span className="muted">{connection === 'connecting' ? 'Connecting...' : 'Waiting for a game...'}</span>
      )}
      <div className="spacer" />
      <span
        className={`conn conn-${connection}`}
        title={
          game
            ? `llm: ${game.mode.llm} · disks: ${game.mode.disks} · search: ${game.mode.search}${game.mode.impostorEgressBlocked ? ' · impostor egress blocked' : ''}`
            : undefined
        }
      >
        {connection}
      </span>
      <label className="toggle" title="Reveal roles, answer keys and impostor thoughts">
        <input type="checkbox" checked={godMode} onChange={(e) => setGodMode(e.target.checked)} /> God mode
      </label>
      <div className="seg">
        <button className={source === 'live' ? 'on' : ''} onClick={() => setSource('live')}>
          LIVE
        </button>
        <button
          className={source === 'replay' ? 'on' : ''}
          onClick={() => (source === 'replay' ? restartReplay() : setSource('replay'))}
          title={source === 'replay' ? 'Restart replay' : 'Play recorded game'}
        >
          REPLAY
        </button>
      </div>
      {source === 'replay' ? (
        <div className="seg">
          {[1, 2, 4].map((x) => (
            <button key={x} className={replaySpeed === x ? 'on' : ''} onClick={() => setReplaySpeed(x)}>
              {x}x
            </button>
          ))}
        </div>
      ) : (
        <div className="newgame">
          <input
            type="number"
            min={MIN_AGENTS}
            max={MAX_AGENTS}
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
            title="agent count (6-50)"
          />
          <button className="primary" disabled={busy} onClick={onNewGame}>
            {busy ? 'Starting...' : 'New Game'}
          </button>
          {err && (
            <span className="err" title={err}>
              !
            </span>
          )}
        </div>
      )}
    </header>
  );
}
