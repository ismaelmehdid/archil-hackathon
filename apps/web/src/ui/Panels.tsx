'use client';
import { useMemo } from 'react';
import { REFEREE_ID, type Answer } from '@susagent/shared';
import { useViewerStore } from '../store';
import { AgentName, RoleTag, Section, useAgents } from './common';
import { useUi } from './feed';

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
        <h3>
          <AgentName id={REFEREE_ID} />
        </h3>
        {q && (
          <span className="muted">
            Q{q.round}.{q.index + 1}
          </span>
        )}
      </div>
      {q ? <p className="question">{q.text}</p> : <p className="muted">{lastAnnouncement?.text ?? 'No question yet.'}</p>}
      {q && lastAnnouncement && lastAnnouncement.round === game?.round && (
        <p className="muted small">{lastAnnouncement.text}</p>
      )}
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
  return (
    <Section title="Answers" right={<span className="muted">{answers.length}</span>}>
      {answers.length === 0 && <p className="muted">Waiting for answers...</p>}
      <ul className="answers">
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
      title="Live votes"
      right={
        <span className={voting ? 'live-dot' : 'muted'}>
          {voting ? 'VOTING ' : rows.length ? 'result ' : ''}
          {rows.length > 0 && `${rows.length}/${voters}`}
        </span>
      }
    >
      {rows.length === 0 && (
        <p className="muted">{voting ? 'First votes incoming...' : 'Votes appear here live during voting.'}</p>
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
          <b>{agents[e.agentId]?.name ?? e.agentId}</b> was eliminated and was <RoleTag role={e.role} />
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
  const rounds = [...new Set(game.eliminated.map((e) => e.round))].sort((a, b) => b - a);
  return (
    <Section title="Eliminations" right={<span className="muted">{game.eliminated.length} out</span>}>
      <table className="history">
        <thead>
          <tr>
            <th>Rd</th>
            <th>Eliminated</th>
            <th>Role</th>
            <th>Votes</th>
          </tr>
        </thead>
        <tbody>
          {rounds.map((round) => {
            const out = game.eliminated.filter((e) => e.round === round);
            const rv = game.votes.filter((v) => v.round === round);
            return out.map((e, i) => {
              const n = rv.filter((v) => v.targetId === e.agentId).length;
              return (
                <tr key={e.agentId} className={i === 0 ? 'round-first' : ''}>
                  {i === 0 && (
                    <td rowSpan={out.length} title={`${out.length} eliminated in round ${round}`}>
                      {round}
                      {out.length > 1 && <div className="muted small">x{out.length}</div>}
                    </td>
                  )}
                  <td>
                    <AgentName id={e.agentId} showRole={false} />
                  </td>
                  <td>
                    <RoleTag role={e.role} />
                  </td>
                  <td title={`${n} of ${rv.length} votes`}>
                    {n}/{rv.length}
                  </td>
                </tr>
              );
            });
          })}
        </tbody>
      </table>
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
