'use client';
import { useEffect, useMemo, useState } from 'react';
import { DEFAULT_CONFIG, REFEREE_ID, type AgentId, type AgentPublic, type Role } from '@susagent/shared';
import { useViewerStore } from '../store';

export function useAgents(): Record<AgentId, AgentPublic> {
  const agents = useViewerStore((s) => s.game?.agents);
  return useMemo(() => {
    const m: Record<AgentId, AgentPublic> = {};
    for (const a of agents ?? []) m[a.id] = a;
    return m;
  }, [agents]);
}

export function useNow(ms = 250) {
  const [, setT] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setT((t) => t + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
  return performance.now();
}

export function RoleTag({ role }: { role: Role }) {
  return <span className={`role role-${role}`}>{role === 'impostor' ? 'IMPOSTOR' : 'crew'}</span>;
}

/** Clickable agent chip: color dot + name (+ role in god mode / once revealed). */
export function AgentName({ id, showRole = true }: { id: AgentId; showRole?: boolean }) {
  const agents = useAgents();
  const godMode = useViewerStore((s) => s.godMode);
  const role = useViewerStore((s) => s.game?.roles[id]);
  const selectAgent = useViewerStore((s) => s.selectAgent);
  if (id === REFEREE_ID)
    return (
      <button className="agent" onClick={() => selectAgent(REFEREE_ID)}>
        <span className="dot" style={{ background: '#ffd166' }} />
        Referee
      </button>
    );
  const a = agents[id];
  const shownRole = a?.revealedRole ?? (godMode ? role : undefined);
  return (
    <button className={`agent ${a && !a.alive ? 'dead' : ''}`} onClick={() => selectAgent(id)} title={id}>
      <span className="dot" style={{ background: a?.color ?? '#888' }} />
      {a?.name ?? id}
      {showRole && shownRole && <RoleTag role={shownRole} />}
    </button>
  );
}

export function impostorTotal(agentCount: number, ratio = DEFAULT_CONFIG.impostorRatio) {
  return Math.max(1, Math.round(agentCount * ratio));
}

export function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h3>{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}
