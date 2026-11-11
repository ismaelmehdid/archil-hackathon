'use client';
import { useEffect, useMemo, useState } from 'react';
import { API_ROUTES, REFEREE_ID, type Answer, type HallOfFameStats } from '@susagent/shared';
import { useViewerStore } from '../store';
import { AgentName, RoleTag, Section, useAgents } from './common';
import { SERVER_URL, useUi } from './feed';

export function LobbyCard() {
  const game = useViewerStore((s) => s.game);
  const ready = useUi((s) => s.ready);
  if (!game || game.round > 0 || game.status === 'over') return null;
  const ids = [REFEREE_ID, ...game.agents.map((a) => a.id)];
  const total = game.config.agentCount + 1;
  const n = ids.filter((id) => ready[id]).length;
  const archil = Object.values(ready).filter((r) => r.backend === 'archil').length;
  const done = n >= total;
  return (
    <section className="panel lobby">
      <div className="panel-head">
        <h3>{done ? 'Sandboxes ready' : 'Provisioning sandboxes + disks'}</h3>
        <span className={done ? 'ok-text' : 'live-dot'}>
          {n} / {total}
        </span>
      </div>
      <div className="bar-track lobby-track">
        <div className="bar" style={{ width: `${(n / total) * 100}%`, background: done ? 'var(--ok)' : 'var(--accent)' }} />
      </div>
      <p className="muted small">
        {archil > 0 ? `${archil} Archil disk${archil === 1 ? '' : 's'} mounted` : 'Disks: ' + game.mode.disks}
        {' · '}search: {game.mode.search}
        {game.mode.impostorEgressBlocked ? ' · impostor egress blocked' : ''}
      </p>
      <div className="ready-grid">
        {ids.map((id) => (
          <span key={id} className={`ready-chip ${ready[id] ? 'is-ready' : ''}`} title={ready[id]?.diskId ?? 'provisioning...'}>
            <AgentName id={id} showRole={false} />
            {ready[id] ? <span className="check">{ready[id].backend === 'archil' ? 'disk' : 'mem'}</span> : <span className="spin" />}
          </span>
        ))}
      </div>
    </section>
  );
}

export function RefereeCard() {
  const game = useViewerStore((s) => s.game);
  const godMode = useViewerStore((s) => s.godMode);
  const q = game?.questions.filter((x) => x.round === game.round).at(-1);
  const key = q && game?.answerKeys.find((k) => k.questionId === q.id);
  const lastAnnouncement = game?.messages.filter((m) => m.agentId === REFEREE_ID).at(-1);
  return (
    <section className="panel referee">
      <div className="panel-head">
        <h3>The question</h3>
        {q && <span className="muted">Round {q.round}</span>}
      </div>
      {q ? <p className="question">{q.text}</p> : <p className="muted">{lastAnnouncement?.text ?? 'No question yet.'}</p>}
      {game?.topic && <p className="muted small">Topic: {game.topic}</p>}
      {godMode && key && (
        <div className="answer-key">
          <b>Answer key:</b> {key.answer}
          {key.sources.map((u) => (
            <a key={u} href={u} target="_blank" rel="noreferrer" className="src">
              {' '}
              [source]
            </a>
          ))}
        </div>
      )}
    </section>
  );
}

/** Public badge for the referee's Keenable Fetch check of an answer's cited source. */
function SourceBadge({ a }: { a: Answer }) {
  const v = a.verification;
  if (!v) return a.sourceUrl ? null : <span className="tag grey">no source</span>;
  const [cls, label] =
    v.verdict === 'supported'
      ? ['green', 'source verified']
      : v.verdict === 'contradicted' || v.verdict === 'not_found'
        ? ['red', v.verdict === 'not_found' ? 'source not found' : 'source unsupported']
        : v.verdict === 'no_source'
          ? ['grey', 'no source']
          : ['grey', 'source unchecked'];
  return (
    <span className={`tag ${cls}`} title={v.quote ? `Referee: "${v.quote}"` : undefined}>
      {label}
    </span>
  );
}

export function AnswersPanel() {
  const game = useViewerStore((s) => s.game);
  const godMode = useViewerStore((s) => s.godMode);
  const agents = useAgents();
  const answers = game?.answers.filter((a) => a.round === game.round) ?? [];
  const alive = game?.agents.filter((a) => a.alive).length ?? 0;
  // Once voting starts the answers fold away (one click to reopen, one line each) so the votes stay in view.
  const compact = game?.phase === 'voting' || game?.phase === 'reveal';
  const foldKey = `${game?.round}:${compact}`;
  const [openKey, setOpenKey] = useState<string | null>(null);
  const folded = compact && openKey !== foldKey;
  const copies = game?.copySuspicions?.filter((c) => c.round === game.round) ?? [];
  return (
    <Section
      title="Answers"
      right={
        compact && answers.length > 0 ? (
          <button className="fold" onClick={() => setOpenKey(folded ? foldKey : null)}>
            {folded ? `Show all ${answers.length}` : 'Hide'}
          </button>
        ) : (
          <span className="muted">
            {answers.length} / {alive}
          </span>
        )
      }
    >
      {answers.length === 0 && <p className="muted">Waiting for answers...</p>}
      {folded && answers.length > 0 && <p className="muted small">{answers.length} answers given. Now everyone votes.</p>}
      <ul className={compact ? 'answers compact' : 'answers'} hidden={folded}>
        {answers.map((a) => (
          <li
            key={a.id}
            className={`answer fade-in ${godMode && a.fabricated ? 'fabricated' : ''} ${godMode && a.copiedFrom ? 'copied' : ''}`}
          >
            <div className="row">
              <AgentName id={a.agentId} />
              <SourceBadge a={a} />
              {godMode && a.fabricated && <span className="tag red">FABRICATED</span>}
              {godMode && a.copiedFrom && (
                <span className="tag amber">copied from {agents[a.copiedFrom]?.name ?? a.copiedFrom}</span>
              )}
            </div>
            <div className="text">{a.text}</div>
            {a.sourceUrl && (
              <a className="src" href={a.sourceUrl} target="_blank" rel="noreferrer">
                {a.sourceUrl.replace(/^https?:\/\//, '').slice(0, 60)}
              </a>
            )}
            {a.verification?.quote && a.verification.verdict !== 'no_source' && (
              <div className="muted verify-quote">Referee: "{a.verification.quote}"</div>
            )}
          </li>
        ))}
      </ul>
      {copies.map((c) => (
        <p key={`${c.agentId}-${c.fromAgentId}`} className="copy-flag fade-in">
          <span className="tag amber">{c.via === 'archil-grep' ? 'Archil grep' : 'grep'}: copy suspected</span>{' '}
          <AgentName id={c.agentId} /> looks copied from <AgentName id={c.fromAgentId} />{' '}
          <span className="muted">"{c.phrase}"</span>
        </p>
      ))}
    </Section>
  );
}

export function LiveVotesPanel() {
  const game = useViewerStore((s) => s.game);
  const liveVotes = useViewerStore((s) => s.liveVotes);
  const liveTally = useViewerStore((s) => s.liveTally);
  const agents = useAgents();
  const rows = useMemo(() => Object.values(liveVotes).sort((a, b) => a.at - b.at), [liveVotes]);
  const tally = useMemo(() => Object.entries(liveTally).sort((a, b) => b[1] - a[1]), [liveTally]);
  const max = Math.max(1, ...tally.map((t) => t[1]));
  const elimThisRound = game?.eliminated.filter((e) => e.round === game.round) ?? [];
  const elimIds = new Set(elimThisRound.map((e) => e.agentId));
  const voters = game ? game.agents.filter((a) => a.alive).length + elimThisRound.length : 0;
  const voting = game?.phase === 'voting';

  return (
    <Section
      title="Votes"
      right={
        <span className={voting ? 'live-dot' : 'muted'}>
          {rows.length > 0 ? `${rows.length} of ${voters} voted` : voting ? 'voting now' : ''}
        </span>
      }
    >
      {rows.length === 0 && (
        <p className="muted">{voting ? 'First votes incoming...' : 'Votes show up here during the vote.'}</p>
      )}
      {tally.length > 0 && (
        <div className="tally">
          {tally.map(([id, n]) => (
            <div key={id} className={`bar-row ${elimIds.has(id) ? 'elim' : ''}`}>
              <div className="bar-label">
                <AgentName id={id} />
              </div>
              <div className="bar-track">
                <div className="bar" style={{ width: `${(n / max) * 100}%`, background: agents[id]?.color ?? '#888' }} />
              </div>
              <div className="bar-n">{n}</div>
            </div>
          ))}
        </div>
      )}
      {elimThisRound.map((e) => (
        <div key={e.agentId} className={`elim-banner fade-in role-bg-${e.role}`}>
          <b>{agents[e.agentId]?.name ?? e.agentId}</b> was voted out. They were <RoleTag role={e.role} />
        </div>
      ))}
      <ul className="votes">
        {rows
          .slice()
          .reverse()
          .map((v) => (
            <li key={v.voterId} className="vote slide-in">
              <div className="row">
                <AgentName id={v.voterId} showRole={false} />
                <span className="arrow">→</span>
                <AgentName id={v.targetId} showRole={false} />
              </div>
              <div className="reason">{v.reason}</div>
            </li>
          ))}
      </ul>
    </Section>
  );
}

export function HistoryPanel() {
  const game = useViewerStore((s) => s.game);
  if (!game || game.eliminated.length === 0) return null;
  const list = [...game.eliminated].sort((a, b) => b.round - a.round);
  return (
    <Section title="Voted out so far" right={<span className="muted">{game.eliminated.length}</span>}>
      <ul className="out-list">
        {list.map((e) => {
          const rv = game.votes.filter((v) => v.round === e.round);
          const n = rv.filter((v) => v.targetId === e.agentId).length;
          return (
            <li key={e.agentId}>
              <span className="out-round">R{e.round}</span>
              <AgentName id={e.agentId} showRole={false} />
              <RoleTag role={e.role} />
              <span className="muted small out-votes">
                {n} of {rv.length} votes
              </span>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

export function ThoughtsPanel() {
  const thoughts = useViewerStore((s) => s.thoughts);
  const godMode = useViewerStore((s) => s.godMode);
  if (!godMode) return null;
  return (
    <Section title="Private thoughts (god mode)">
      {thoughts.length === 0 && <p className="muted">No thoughts yet.</p>}
      <ul className="thoughts">
        {thoughts
          .slice(-40)
          .reverse()
          .map((t) => (
            <li key={t.seq} className="fade-in">
              <AgentName id={t.agentId} />{' '}
              <span className="muted small">
                r{t.round} {t.phase}
              </span>
              <div className="text">{t.text}</div>
            </li>
          ))}
      </ul>
    </Section>
  );
}

/** Cross-game stats from GET /api/stats. Fetched on load and shortly after each game_over. */
export function HallOfFameCard() {
  const source = useViewerStore((s) => s.source);
  const gameId = useViewerStore((s) => s.game?.gameId ?? null);
  const over = useViewerStore((s) => s.game?.status === 'over');
  const [stats, setStats] = useState<HallOfFameStats | null>(null);
  useEffect(() => {
    if (source !== 'live') return;
    let alive = true;
    const load = () =>
      fetch(SERVER_URL + API_ROUTES.stats, { signal: AbortSignal.timeout(8000) })
        .then((r) => (r.ok ? (r.json() as Promise<HallOfFameStats>) : null))
        .then((s) => {
          if (alive && s) setStats(s);
        })
        .catch(() => undefined);
    void load();
    // The server writes the game's rows asynchronously after game_over: refetch a few times.
    const timers = over ? [4000, 12_000, 25_000].map((ms) => setTimeout(load, ms)) : [];
    return () => {
      alive = false;
      timers.forEach(clearTimeout);
    };
  }, [source, gameId, over]);
  if (source !== 'live' || !stats) return null;
  const pct = (x: number | null) => (x === null ? '-' : `${Math.round(x * 100)}%`);
  return (
    <Section
      title="Hall of fame"
      right={<span className="muted" title={stats.backend === 'archil' ? 'SQLite on a persistent Archil disk' : 'in-memory (this server only)'}>{stats.totalGames} games · {stats.backend === 'archil' ? 'Archil SQLite' : 'memory'}</span>}
    >
      <p className="small">
        Crew win rate <b>{pct(stats.crewWinRate)}</b>
        <span className="muted"> ({stats.crewWins}/{stats.totalGames})</span>
      </p>
      <p className="small">
        Best detective:{' '}
        {stats.bestDetective ? (
          <>
            <b>{stats.bestDetective.name}</b>
            <span className="muted">
              {' '}
              {pct(stats.bestDetective.ratio)} correct votes over {stats.bestDetective.games} games
            </span>
          </>
        ) : (
          <span className="muted">not enough games yet</span>
        )}
      </p>
      <p className="small">
        Most convincing impostor:{' '}
        {stats.mostConvincingImpostor ? (
          <>
            <b>{stats.mostConvincingImpostor.name}</b>
            <span className="muted">
              {' '}
              survived {stats.mostConvincingImpostor.survived}/{stats.mostConvincingImpostor.impostorGames} impostor games
            </span>
          </>
        ) : (
          <span className="muted">none survived yet</span>
        )}
      </p>
      {stats.lastGames.length > 0 && (
        <p className="small muted" title="Last games, newest first (C = crew win, I = impostor win)">
          Last {stats.lastGames.length}:{' '}
          {stats.lastGames.map((g) => (
            <span key={g.gameId} title={`${g.gameId}: ${g.winner} won in ${g.rounds} rounds, ${g.agentCount} agents`} className="hof-dot" style={{ color: g.winner === 'crew' ? 'var(--crew)' : 'var(--imp)' }}>
              {g.winner === 'crew' ? 'C' : 'I'}
            </span>
          ))}
        </p>
      )}
    </Section>
  );
}
