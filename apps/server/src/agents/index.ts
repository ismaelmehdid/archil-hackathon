import {
  DISK_PATHS,
  REFEREE_ID,
  type GameSnapshot,
  type AgentFactory,
  type AgentFactoryInput,
  type AgentRuntime,
  type AnswerContext,
  type AnswerDraft,
  type DiskSnapshot,
  type ModeInfo,
  type RefereeContext,
  type RefereeQuestionDraft,
  type RefereeRuntime,
  type Role,
  type VoteContext,
  type VoteDecision,
} from '@susagent/shared';
import { MemoryDisk, type AgentDisk } from './disk';
import { AgentEnv, toolsFor } from './env';
import { heuristicCrewAnswer, heuristicImpostorAnswer, heuristicQuestion, heuristicVote } from './heuristic';
import { searchProvider } from './search';
import { llmAnswer, llmQuestion, llmVote } from './llm';
import { ArchilDisk, createAgentSandbox, createArchilDisk, sandboxFetcher } from './archil';
import { loadLessons, lessonsSummaryLine, PROMPT_LESSONS, recordGameOver } from './lessons';

export { toolsFor } from './env';
export { searchWeb, searchProvider } from './search';

/** Pluggable thinking layer: heuristic (mock) or LLM (falls back to heuristic per call). */
export interface Brain {
  answer(env: AgentEnv, ctx: AnswerContext): Promise<AnswerDraft>;
  vote(env: AgentEnv, ctx: VoteContext): Promise<VoteDecision>;
  question(env: AgentEnv, ctx: RefereeContext): Promise<RefereeQuestionDraft>;
}

export const heuristicBrain: Brain = {
  answer: (env, ctx) => (env.role === 'impostor' ? heuristicImpostorAnswer(env, ctx) : heuristicCrewAnswer(env, ctx)),
  vote: heuristicVote,
  question: heuristicQuestion,
};

/** LLM brain; any error inside a call falls back to the heuristic brain in the runtime wrappers. */
export const llmBrain: Brain = { answer: llmAnswer, vote: llmVote, question: llmQuestion };

class PlayerRuntime implements AgentRuntime {
  constructor(
    private env: AgentEnv,
    private brain: Brain,
  ) {}
  get id() {
    return this.env.id;
  }
  get role(): Role {
    return this.env.role as Role;
  }
  get hasWebSearch() {
    return this.env.hasWebSearch;
  }
  async answer(ctx: AnswerContext): Promise<AnswerDraft> {
    try {
      const d = await this.brain.answer(this.env, ctx);
      return { ...d, text: d.text.slice(0, ctx.maxChars) };
    } catch (err) {
      this.env.log('warn', `answer failed, using heuristic: ${(err as Error).message}`);
      return heuristicBrain.answer(this.env, ctx);
    }
  }
  async vote(ctx: VoteContext): Promise<VoteDecision> {
    try {
      const d = await this.brain.vote(this.env, ctx);
      if (ctx.candidates.includes(d.targetId)) return d;
      throw new Error(`invalid target ${d.targetId}`);
    } catch (err) {
      this.env.log('warn', `vote failed, using heuristic: ${(err as Error).message}`);
      return heuristicBrain.vote(this.env, ctx);
    }
  }
  readDisk(): Promise<DiskSnapshot> {
    return this.env.disk.snapshot();
  }
  dispose(): Promise<void> {
    return this.env.disk.dispose();
  }
}

class RefereeRuntimeImpl implements RefereeRuntime {
  readonly id = REFEREE_ID;
  constructor(
    private env: AgentEnv,
    private brain: Brain,
  ) {}
  async askQuestion(ctx: RefereeContext): Promise<RefereeQuestionDraft> {
    try {
      return await this.brain.question(this.env, ctx);
    } catch (err) {
      this.env.log('warn', `question failed, using heuristic: ${(err as Error).message}`);
      return heuristicBrain.question(this.env, ctx);
    }
  }
  readDisk(): Promise<DiskSnapshot> {
    return this.env.disk.snapshot();
  }
  dispose(): Promise<void> {
    return this.env.disk.dispose();
  }
}

/** Run tasks with a concurrency cap, preserving order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

export interface FactoryOptions {
  forceMock?: boolean;
}

function computeMode(forceMock: boolean): ModeInfo {
  const mock = forceMock || process.env.SUSAGENT_MOCK === '1';
  return {
    llm: !mock && process.env.OPENAI_API_KEY ? 'openai' : 'mock',
    disks: !mock && process.env.ARCHIL_API_KEY ? 'archil' : 'memory',
    search: mock ? 'mock' : searchProvider(),
    // Becomes true (mutated in place) only once every impostor sandbox's deny-egress firewall is verified.
    impostorEgressBlocked: false,
  };
}

const PROVISION_DEADLINE_MS = 75_000;

/**
 * Creates the agent factory. Call once per game: createAgentFactory({ forceMock: config.mock }).
 * Sync. createAll provisions referee + all agents in parallel (concurrency 10):
 *   disks first (agent_ready per actor), then sandboxes with per-role firewalls (Archil only; set
 *   SUSAGENT_SANDBOXES=0 to skip). `mode` is mutated in place if a backend degrades or the firewall is verified.
 */
export function createAgentFactory(opts: FactoryOptions = {}): AgentFactory {
  const mode = computeMode(!!opts.forceMock);
  const brain: Brain = mode.llm === 'openai' ? llmBrain : heuristicBrain;

  return {
    mode,
    recordGameOver: (snapshot: GameSnapshot) => recordGameOver(mode, snapshot),
    async createAll(input: AgentFactoryInput) {
      const t0 = Date.now();
      const { config, hooks, agents, secrets, gameId } = input;
      const roleOf = new Map(secrets.map((s) => [s.id, s]));
      const impostors = secrets.filter((s) => s.role === 'impostor').map((s) => s.id);
      const mockSearch = mode.search === 'mock';
      const gameStartIso = new Date().toISOString();
      const log = (level: 'info' | 'warn' | 'error', message: string) => hooks.emit({ type: 'log', level, message: `[agents] ${message}` });

      const actors = [{ id: REFEREE_ID, name: 'Referee' }, ...agents.map((a) => ({ id: a.id, name: a.name }))];
      const lessonsP = loadLessons(mode);
      let archilFailures = 0;

      // Cross-game lessons (persistent store), loaded in parallel with the per-game disks.
      const lessons = await lessonsP;
      const summary = lessonsSummaryLine(lessons);
      console.log(summary);
      hooks.emit({ type: 'log', level: 'info', message: summary });

      // 1) Disks, in parallel.
      const envs = await mapLimit(actors, 10, async (actor) => {
        let disk: AgentDisk;
        if (mode.disks === 'archil') {
          try {
            disk = await createArchilDisk(gameId, actor.id);
          } catch (err) {
            archilFailures++;
            log('warn', `Archil disk for ${actor.id} failed (${(err as Error).message.slice(0, 120)}); using memory disk`);
            disk = new MemoryDisk(actor.id);
          }
        } else disk = new MemoryDisk(actor.id);
        const secret = roleOf.get(actor.id);
        const role = actor.id === REFEREE_ID ? ('referee' as const) : (secret?.role ?? 'crew');
        const model =
          role === 'referee' ? config.models.referee : (secret?.model ?? (role === 'impostor' ? config.models.impostor : config.models.crew));
        const env = new AgentEnv(actor.id, role, actor.name, model, disk, hooks, config, {
          mockSearch,
          gameId,
          gameStartIso,
          fellowImpostors: role === 'impostor' ? impostors.filter((x) => x !== actor.id) : [],
        });
        await env.appendNote(
          role === 'impostor'
            ? `I am an IMPOSTOR. Fellow impostors: ${impostors.filter((x) => x !== actor.id).join(', ') || 'none'}. No web_search tool — blend in.`
            : role === 'referee'
              ? 'I am the referee. I ask one checkable recent-news question per round.'
              : 'I am crew. Search, answer truthfully, find the impostors.',
        );
        const roleLessons = lessons.byRole[role];
        env.opts.lessons = roleLessons;
        if (roleLessons.length) {
          const recent = roleLessons.slice(-PROMPT_LESSONS);
          await env.update(DISK_PATHS.notes, (prev) => `${prev ?? ''}\n## Lessons from previous games (${role})\n${recent.map((l) => `- ${l}`).join('\n')}\n`);
        }
        hooks.emit({ type: 'agent_ready', agentId: actor.id, backend: disk.backend, diskId: disk.diskId });
        return env;
      });
      if (mode.disks === 'archil' && archilFailures === actors.length) mode.disks = 'memory';

      // 2) Sandboxes with per-role egress firewall (best effort, bounded by a global deadline).
      const archilEnvs = envs.filter((e) => e.disk instanceof ArchilDisk);
      if (archilEnvs.length && process.env.SUSAGENT_SANDBOXES !== '0') {
        let planRequired = false;
        const verified = new Set<string>();
        const outcomes = await mapLimit(archilEnvs, 10, async (env) => {
          const remaining = PROVISION_DEADLINE_MS - (Date.now() - t0);
          if (planRequired || remaining < 5000) return null;
          const out = await createAgentSandbox(gameId, env.id, env.role, env.disk as ArchilDisk);
          if (out.planRequired) planRequired = true;
          if (out.sandbox && out.firewall) {
            verified.add(env.id);
            if (env.hasWebSearch && process.env.KEENABLE_API_KEY) env.opts.sandboxFetch = sandboxFetcher(out.sandbox);
          }
          if (out.error && !out.planRequired) log('warn', `sandbox for ${env.id} failed: ${out.error}`);
          return out;
        });
        if (planRequired) log('warn', 'Archil plan lacks sandbox networking (sandbox_network_plan_required): web_search removed server-side for impostors only, no firewall.');
        const sandboxes = outcomes.filter((o) => o?.sandbox).length;
        mode.impostorEgressBlocked = impostors.length > 0 && impostors.every((id) => verified.has(id));
        log('info', `sandboxes: ${sandboxes}/${archilEnvs.length}, firewall verified on ${verified.size}, impostorEgressBlocked=${mode.impostorEgressBlocked}`);
      }

      const [refEnv, ...playerEnvs] = envs;
      return {
        referee: new RefereeRuntimeImpl(refEnv!, brain),
        agents: playerEnvs.map((e) => new PlayerRuntime(e, brain)),
      };
    },
  };
}
