import {
  DISK_PATHS,
  type AgentHooks,
  type AgentId,
  type AgentPublic,
  type GameConfig,
  type Phase,
  type Role,
  type SearchResult,
  type SuspectsFile,
} from '@susagent/shared';
import type { AgentDisk } from './disk';
import { searchWebDetailed } from './search';

export type ActorRole = Role | 'referee';

/** Tool names per role. web_search is ABSENT for impostors (not merely forbidden). */
export function toolsFor(role: ActorRole): string[] {
  if (role === 'referee') return ['web_search', 'read_my_disk', 'write_note', 'submit_question'];
  if (role === 'impostor') return ['read_my_disk', 'write_note', 'submit_answer', 'cast_vote'];
  return ['web_search', 'read_my_disk', 'write_note', 'submit_answer', 'cast_vote'];
}

/** Everything an agent/referee runtime needs: identity, disk, hooks, budget bookkeeping. */
export class AgentEnv {
  private searchesUsed = new Map<number, number>();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    readonly id: AgentId,
    readonly role: ActorRole,
    readonly name: string,
    readonly model: string,
    readonly disk: AgentDisk,
    readonly hooks: AgentHooks,
    readonly config: GameConfig,
    readonly opts: {
      mockSearch: boolean;
      gameId: string;
      /** ISO time the game started: pins Keenable query_time so the web is frozen for every search. */
      gameStartIso: string;
      fellowImpostors?: AgentId[];
      publicSelf?: AgentPublic;
      /** Runs the keyed search from inside this agent's Archil sandbox (firewall injects the key). */
      sandboxFetch?: (url: string, body: unknown) => Promise<any>;
    },
  ) {}

  get hasWebSearch(): boolean {
    return toolsFor(this.role).includes('web_search');
  }

  budgetRemaining(round: number): number {
    return Math.max(0, this.config.searchBudgetPerRound - (this.searchesUsed.get(round) ?? 0));
  }

  log(level: 'info' | 'warn' | 'error', message: string) {
    try {
      this.hooks.emit({ type: 'log', level, message: `[${this.id}] ${message}` });
    } catch {
      /* ignore */
    }
  }

  thought(round: number, phase: Phase, text: string) {
    this.hooks.emit({ type: 'agent_thought', agentId: this.id, round, phase, text: text.slice(0, 400) });
  }

  /**
   * The web_search tool. Enforces the per-round budget in code.
   * Returns null when denied (budget exhausted or the role has no search tool).
   */
  async search(round: number, query: string, topic?: string): Promise<SearchResult[] | null> {
    if (!this.hasWebSearch) return null; // impostors never reach the network
    query = query.slice(0, 200);
    if (this.budgetRemaining(round) <= 0) {
      this.hooks.emit({ type: 'search_denied', agentId: this.id, round, query, reason: 'budget_exhausted' });
      return null;
    }
    this.searchesUsed.set(round, (this.searchesUsed.get(round) ?? 0) + 1);
    const isRef = this.role === 'referee';
    const { results, mock } = await searchWebDetailed(query, {
      topic,
      forceMock: this.opts.mockSearch,
      mode: isRef ? 'pro' : 'realtime',
      sessionId: `${this.opts.gameId}-${this.id}`,
      queryTime: this.opts.gameStartIso,
      publishedAfter: isRef ? '7d' : undefined,
      sandboxFetch: this.opts.sandboxFetch,
    });
    this.hooks.emit({
      type: 'search_performed',
      search: { agentId: this.id, round, query, results, budgetRemaining: this.budgetRemaining(round), mock },
    });
    const path = `${DISK_PATHS.sourcesDir}/r${round}.md`;
    const block =
      `### ${query}\n` + results.map((r) => `- [${r.title}](${r.url})\n  ${r.snippet}`).join('\n') + '\n\n';
    await this.update(path, (prev) => (prev ?? `# Round ${round} sources\n\n`) + block);
    return results;
  }

  /** Serialized read-modify-write on this agent's disk; emits disk_updated. Never throws. */
  update(path: string, fn: (prev: string | null) => string): Promise<void> {
    const run = async () => {
      try {
        const prev = await this.disk.read(path);
        await this.disk.write(path, fn(prev));
        this.hooks.emit({ type: 'disk_updated', agentId: this.id, path });
      } catch (err) {
        this.log('warn', `disk write ${path} failed: ${(err as Error).message}`);
      }
    };
    this.writeChain = this.writeChain.then(run, run);
    return this.writeChain;
  }

  appendNote(text: string): Promise<void> {
    return this.update(DISK_PATHS.notes, (prev) => (prev ?? `# Notes — ${this.name}\n\n`) + `- ${text}\n`);
  }

  /** answers.md keeps newest round first. */
  recordAnswer(round: number, question: string, answer: string, sourceUrl?: string): Promise<void> {
    const entry = `## Round ${round}\n**Q:** ${question}\n**A:** ${answer}\n${sourceUrl ? `Source: ${sourceUrl}\n` : ''}\n`;
    return this.update(DISK_PATHS.answers, (prev) => {
      const body = (prev ?? '').replace(/^# Answers[^\n]*\n\n?/, '');
      return `# Answers — ${this.name}\n\n${entry}${body}`;
    });
  }

  recordSuspects(round: number, suspicion: Record<AgentId, number>, reasons: Record<AgentId, string>) {
    const file: SuspectsFile = {
      round,
      updatedAt: Date.now(),
      suspects: Object.fromEntries(
        Object.entries(suspicion).map(([id, score]) => [id, { score: round2(score), reason: reasons[id] ?? '' }]),
      ),
    };
    return this.update(DISK_PATHS.suspects, () => JSON.stringify(file, null, 2));
  }

  async readSuspects(): Promise<SuspectsFile | null> {
    try {
      const raw = await this.disk.read(DISK_PATHS.suspects);
      return raw ? (JSON.parse(raw) as SuspectsFile) : null;
    } catch {
      return null;
    }
  }
}

export const round2 = (n: number) => Math.round(Math.max(0, Math.min(1, n)) * 100) / 100;
