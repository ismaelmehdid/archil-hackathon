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
