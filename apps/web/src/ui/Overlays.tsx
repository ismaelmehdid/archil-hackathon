'use client';
import { useEffect, useState } from 'react';
import {
  API_ROUTES,
  REFEREE_ID,
  type DiskSnapshot,
  type SuspectsFile,
} from '@susagent/shared';
import { useViewerStore } from '../store';
import { AgentName, RoleTag, useAgents } from './common';
import { createGame, fixture, restartReplay, SERVER_URL, useUi } from './feed';

/** Same delay as the 3D role card, so the caption doesn't spoil the role before the launch. */
const ROLE_REVEAL_DELAY_MS = 900;

function joinNames(names: string[]) {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * One big plain-language caption, top-centre over the arena, that always says what is happening right now.
 * A first-time viewer should get each moment in ~2 seconds.
 */
export function PhaseCaption() {
  const game = useViewerStore((s) => s.game);
  const liveVoteCount = useViewerStore((s) => Object.keys(s.liveVotes).length);
  const eliminations = useViewerStore((s) => s.eliminations);
  useNowWhile(game?.phase === 'reveal', 250);
  if (!game) return null;
  const { phase, round } = game;
  const rounds = game.config.rounds;
  const alive = game.agents.filter((a) => a.alive).length;
  const outNow = game.eliminated.filter((e) => e.round === round);
  const roundTag = round > 0 ? `Round ${round}/${rounds}` : '';

  let title = '';
  let sub = '';
  switch (phase) {
    case 'lobby':
      title = 'Getting the players ready…';
      sub = `${game.config.agentCount} AI players are joining. A few of them are secret impostors.`;
      break;
    case 'question': {
      title = 'The referee asks a question';
      sub = 'Everyone has to answer it. The impostors will try to bluff.';
      break;
    }
    case 'answering': {
      const n = game.answers.filter((a) => a.round === round).length;
      title = 'Everyone answers…';
      sub = `${n} of ${alive} answers are in. Liars give fake facts.`;
      break;
    }
    case 'voting': {
      const voters = alive + outNow.length;
      title = 'Vote! Who is the impostor?';
      sub = `${liveVoteCount} of ${voters} have voted. Arrows show who votes for whom.`;
      break;
    }
    case 'reveal': {
      if (!outNow.length) {
        title = 'Counting the votes…';
        sub = 'The most-voted player gets launched off the field.';
        break;
      }
      const names = outNow.map((e) => game.agents.find((a) => a.id === e.agentId)?.name ?? e.agentId);
      const lastAt = Math.max(...outNow.map((e) => eliminations[e.agentId]?.at ?? 0));
      const shown = performance.now() - lastAt >= ROLE_REVEAL_DELAY_MS;
      title = `${joinNames(names)} ${names.length > 1 ? 'were' : 'was'} voted out…`;
      if (shown) {
        const roles = outNow.map((e, i) => `${names[i]} was ${e.role === 'impostor' ? 'an IMPOSTOR' : 'innocent CREW'}`);
        sub = roles.join(' · ');
      } else sub = 'and was…';
      break;
    }
    case 'game_over':
      title = game.winner === 'impostor' ? 'Game over · The impostors win' : 'Game over · The crew wins';
      sub = game.winReason ?? '';
      break;
  }
  const roleClass =
    phase === 'reveal' && outNow.length && sub !== 'and was…'
      ? outNow.some((e) => e.role === 'impostor')
        ? 'cap-imp'
        : 'cap-crew'
      : '';
  return (
    <div className="caption-wrap">
      <div className={`caption cap-${phase} ${roleClass}`} key={`${round}:${phase}`}>
        {roundTag && phase !== 'lobby' && phase !== 'game_over' && <div className="cap-round">{roundTag}</div>}
        <div className="cap-title">{title}</div>
        {sub && <div className="cap-sub">{sub}</div>}
      </div>
    </div>
  );
}

/** Re-renders every `ms` while `on` (used for the timed role reveal in the caption). */
function useNowWhile(on: boolean, ms: number) {
  const [, setT] = useState(0);
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => setT((t) => t + 1), ms);
    return () => clearInterval(id);
  }, [on, ms]);
}

export function Banner() {
  const banner = useUi((s) => s.banner);
  if (!banner) return null;
  return (
    <div className="banner">
      {banner}
      <button onClick={() => useUi.setState({ banner: null })}>×</button>
    </div>
  );
}

function useDisk(agentId: string | null): { disk: DiskSnapshot | null; error: string | null } {
  const source = useViewerStore((s) => s.source);
  const gameId = useViewerStore((s) => s.game?.gameId);
  const version = useUi((s) => (agentId ? s.diskVersion[agentId] ?? 0 : 0));
  const [disk, setDisk] = useState<DiskSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!agentId) return;
    if (source === 'replay') {
      setDisk(fixture.disks[agentId] ?? null);
      setError(fixture.disks[agentId] ? null : 'No disk in replay fixture.');
      return;
    }
    if (!gameId) return;
    let cancelled = false;
    fetch(SERVER_URL + API_ROUTES.disk(gameId, agentId))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: DiskSnapshot) => {
        if (!cancelled) {
          setDisk(d);
          setError(null);
        }
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [agentId, source, gameId, version]);

  return { disk: agentId && disk?.agentId === agentId ? disk : null, error };
}

function SuspectsTable({ content }: { content: string }) {
  let parsed: SuspectsFile | null = null;
  try {
    parsed = JSON.parse(content) as SuspectsFile;
  } catch {
    return <pre>{content}</pre>;
  }
  const rows = Object.entries(parsed?.suspects ?? {}).sort((a, b) => b[1].score - a[1].score);
  if (!rows.length) return <p className="muted small">No suspects yet.</p>;
  return (
    <table className="history">
      <thead>
        <tr>
          <th>Suspect</th>
          <th>Score</th>
          <th>Reason</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([id, s]) => (
          <tr key={id}>
            <td>
              <AgentName id={id} showRole={false} />
            </td>
            <td>{Math.round(s.score * 100)}%</td>
            <td className="small">{s.reason}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function SelectedAgentPanel() {
  const id = useViewerStore((s) => s.selectedAgentId);
  const selectAgent = useViewerStore((s) => s.selectAgent);
  const game = useViewerStore((s) => s.game);
  const godMode = useViewerStore((s) => s.godMode);
  const agents = useAgents();
  const { disk, error } = useDisk(id);
  if (!id || !game) return null;
  const isRef = id === REFEREE_ID;
  const a = agents[id];
  const role = a?.revealedRole ?? (godMode ? game.roles[id] : undefined);
  const votes = game.votes.filter((v) => v.voterId === id);
  const received = game.votes.filter((v) => v.targetId === id && v.round === game.round).length;
  const files = disk?.files ?? [];
  const byPath = (p: string) => files.find((f) => f.path.replace(/^\//, '') === p);
  const answers = byPath('answers.md');
  const suspects = byPath('suspects.json');
  const notes = byPath('notes.md');
  const others = files.filter((f) => ![answers, suspects, notes].includes(f));

  return (
    <div className="selected">
      <div className="panel-head">
        <h3>
          <span className="dot big" style={{ background: isRef ? '#ffd166' : a?.color ?? '#888' }} />
          {isRef ? 'Referee' : a?.name ?? id}
          {role && <RoleTag role={role} />}
        </h3>
        <button className="close" onClick={() => selectAgent(null)}>
          ×
        </button>
      </div>
      <div className="meta">
        {!isRef && <span className={a?.alive ? 'ok' : 'bad'}>{a?.alive ? 'alive' : 'eliminated'}</span>}
        {!isRef && <span>{game.rooms.find((r) => r.id === a?.roomId)?.name ?? a?.roomId}</span>}
        {!isRef && <span>suspicion {Math.round((game.suspicion[id] ?? 0) * 100)}%</span>}
        {!isRef && received > 0 && <span>{received} votes this round</span>}
        {disk && <span className="badge">{disk.backend}{disk.diskId ? `:${disk.diskId.slice(0, 10)}` : ''}</span>}
      </div>
      {votes.length > 0 && (
        <>
          <h4>Votes cast</h4>
          <ul className="votes compact">
            {votes.map((v) => (
              <li key={v.round}>
                <span className="muted small">r{v.round}</span> → <AgentName id={v.targetId} showRole={false} />{' '}
                <span className="small">{v.reason}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <h4>Disk</h4>
      {error && <p className="muted small">Disk unavailable: {error}</p>}
      {!disk && !error && <p className="muted small">Loading...</p>}
      {answers && (
        <details open>
          <summary>answers.md</summary>
          <pre>{answers.content}</pre>
        </details>
      )}
      {suspects && (
        <details open>
          <summary>suspects.json</summary>
          <SuspectsTable content={suspects.content} />
        </details>
      )}
      {notes &&
        (godMode ? (
          <details>
            <summary>notes.md</summary>
            <pre>{notes.content}</pre>
          </details>
        ) : (
          <p className="muted small">notes.md is private (turn on god mode to read it)</p>
        ))}
      {others.map((f) => (
        <details key={f.path}>
          <summary>{f.path}</summary>
          <pre>{f.content}</pre>
        </details>
      ))}
    </div>
  );
}

export function WinnerOverlay() {
  const game = useViewerStore((s) => s.game);
  const source = useViewerStore((s) => s.source);
  const setSource = useViewerStore((s) => s.setSource);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  if (!game?.winner || dismissed === game.gameId) return null;
  const roleOf = (id: string) => game.roles[id] ?? game.agents.find((a) => a.id === id)?.revealedRole ?? 'crew';
  const sorted = [...game.agents].sort((a, b) => (roleOf(a.id) === 'impostor' ? -1 : 0) - (roleOf(b.id) === 'impostor' ? -1 : 0));

  const newGame = async () => {
    if (source !== 'live') {
      setSource('live');
      return;
    }
    setMsg('Starting...');
    const e = await createGame(game.config.agentCount);
    setMsg(e);
  };

  return (
    <div className="overlay">
      <div className={`winner-card win-${game.winner}`}>
        <div className="win-title">{game.winner === 'crew' ? 'CREW WINS' : 'IMPOSTORS WIN'}</div>
        <p className="win-reason">{game.winReason}</p>
        <div className="roles-grid">
          {sorted.map((a) => (
            <div key={a.id} className={`role-cell ${a.alive ? '' : 'dead'}`}>
              <AgentName id={a.id} showRole={false} />
              <RoleTag role={roleOf(a.id)} />
              {!a.alive && <span className="muted small">out r{game.eliminated.find((e) => e.agentId === a.id)?.round}</span>}
            </div>
          ))}
        </div>
        <div className="win-actions">
          <button className="primary" onClick={newGame}>
            New game
          </button>
          <button onClick={restartReplay}>Replay again</button>
          <button onClick={() => setDismissed(game.gameId)}>Close</button>
        </div>
        {msg && <p className="muted small">{msg}</p>}
      </div>
    </div>
  );
}
