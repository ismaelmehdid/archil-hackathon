/**
 * Deterministic fake agent layer (no LLM, no network). Used by tests, the e2e script, and the
 * server until/unless the real agents factory is available.
 * - Referee asks a canned question per topic with a known answer key.
 * - Crew answer correctly (they "search"); impostors answer wrong, or sometimes copy a revealed answer.
 * - Crew vote for an agent whose answer this round differs from the majority; impostors vote for a crewmate.
 */
import {
  DISK_PATHS,
  REFEREE_ID,
  type AgentFactory,
  type AgentFactoryInput,
  type AgentHooks,
  type AgentId,
  type AgentRuntime,
  type AnswerContext,
  type AnswerDraft,
  type DiskSnapshot,
  type ModeInfo,
  type RefereeContext,
  type RefereeQuestionDraft,
  type RefereeRuntime,
  type Role,
  type SuspectsFile,
  type VoteContext,
  type VoteDecision,
} from '@susagent/shared';
import { MemoryCouncil } from '../agents/council';
import { makeRng, pick, type Rng } from './rules';

export const FAKE_MODE: ModeInfo = { llm: 'mock', disks: 'memory', search: 'mock', impostorEgressBlocked: false };

class MemDisk {
  files = new Map<string, string>();
  constructor(
    private agentId: AgentId,
    private hooks: AgentHooks,
  ) {}
  write(path: string, content: string) {
    this.files.set(path, content);
    this.hooks.emit({ type: 'disk_updated', agentId: this.agentId, path });
  }
  read(path: string) {
    return this.files.get(path) ?? '';
  }
  snapshot(): DiskSnapshot {
    return {
      agentId: this.agentId,
      backend: 'memory',
      files: [...this.files.entries()].map(([path, content]) => ({ path, content })),
    };
  }
}

const WRONG = [
  'It was actually a much smaller deal than reported, around $5M.',
  'Pretty sure it got delayed to next quarter.',
  'The numbers were roughly double what everyone else is saying.',
  'A different company entirely — Quasar Labs.',
  'Nothing major happened; the reports were retracted.',
];

function keyFor(topic: string, round: number, index: number): string {
  const word = topic.split(/\s+/)[0] ?? 'Topic';
  return `${word} answer #${round}.${index}: Northwind ${100 + round * 7 + index}`;
}

export function createFakeAgentFactory(seed = 42): AgentFactory {
  return {
    mode: FAKE_MODE,
    async createAll(input: AgentFactoryInput) {
      const rng = makeRng(seed);
      const keys = new Map<string, string>(); // questionId-ish key -> answer
      const { hooks } = input;

      const refDisk = new MemDisk(REFEREE_ID, hooks);
      const referee: RefereeRuntime = {
        id: REFEREE_ID,
        async askQuestion(ctx: RefereeContext): Promise<RefereeQuestionDraft> {
          const answerKey = keyFor(ctx.topic, ctx.round, ctx.index);
          keys.set(`q${ctx.round}-${ctx.index}`, answerKey);
          hooks.emit({
            type: 'search_performed',
            search: {
              agentId: REFEREE_ID,
              round: ctx.round,
              query: ctx.topic,
              results: [{ title: `${ctx.topic} roundup`, url: 'https://example.com/roundup', snippet: answerKey }],
              budgetRemaining: 99,
              mock: true,
            },
          });
          refDisk.write(
            DISK_PATHS.notes,
            `${refDisk.read(DISK_PATHS.notes)}\n## Round ${ctx.round}\nQ: key = ${answerKey}\n`,
          );
          return {
            text: `Round ${ctx.round} question on "${ctx.topic}": what is the headline figure this week?`,
            answerKey,
            sources: ['https://example.com/roundup'],
          };
        },
        async readDisk() {
          return refDisk.snapshot();
        },
        async dispose() {},
      };

      const agents: AgentRuntime[] = input.secrets.map((sec) => makeAgent(sec.id, sec.role, input, keys, rng));
      // provisioning: emit agent_ready (the engine fills in any we miss)
      hooks.emit({ type: 'agent_ready', agentId: REFEREE_ID, backend: 'memory' });
      for (const a of agents) hooks.emit({ type: 'agent_ready', agentId: a.id, backend: 'memory' });
      return { referee, agents, council: new MemoryCouncil() };
    },
  };
}

function makeAgent(
  id: AgentId,
  role: Role,
  input: AgentFactoryInput,
  keys: Map<string, string>,
  rng: Rng,
): AgentRuntime {
  const { hooks, config } = input;
  const disk = new MemDisk(id, hooks);
  const name = input.agents.find((a) => a.id === id)?.name ?? id;
  disk.files.set(DISK_PATHS.answers, `# Answers — ${name}\n`);
  disk.files.set(DISK_PATHS.notes, role === 'impostor' ? '# Notes\nBlend in. Copy when possible.\n' : '# Notes\n');

  return {
    id,
    role,
    hasWebSearch: role === 'crew',
    async answer(ctx: AnswerContext): Promise<AnswerDraft> {
      const key = keys.get(ctx.question.id) ?? 'Unknown';
      let draft: AnswerDraft;
      if (role === 'crew') {
        hooks.emit({
          type: 'search_performed',
          search: {
            agentId: id,
            round: ctx.round,
            query: ctx.question.text.slice(0, 80),
            results: [{ title: 'News roundup', url: 'https://example.com/roundup', snippet: key }],
            budgetRemaining: Math.max(0, config.searchBudgetPerRound - 1),
            mock: true,
          },
        });
        disk.write(`${DISK_PATHS.sourcesDir}/r${ctx.round}.md`, `# Sources r${ctx.round}\n- ${key}\n`);
        draft = { text: key, sourceUrl: 'https://example.com/roundup' };
      } else {
        const w = ctx.whisper;
        if (w) {
          const gist = w.text.replace(/^someone mentioned\s+/i, '');
          hooks.emit({
            type: 'agent_thought',
            agentId: id,
            round: ctx.round,
            phase: 'answering',
            text: `Whisper says: "${w.text}". Building on it.`,
          });
          draft = {
            text: `It was ${gist}, as far as I could tell.`,
            sourceUrl: 'https://news-totally-real.example/story',
            copiedFrom: w.fromAgentId,
          };
        } else {
          hooks.emit({
            type: 'agent_thought',
            agentId: id,
            round: ctx.round,
            phase: 'answering',
            text: 'No search tool. Inventing something plausible.',
          });
          draft = { text: pick(WRONG, rng)!, sourceUrl: 'https://news-totally-real.example/story' };
        }
      }
      disk.write(
        DISK_PATHS.answers,
        disk
          .read(DISK_PATHS.answers)
          .replace(/^(# .*\n)/, `$1\n## Round ${ctx.round} — ${ctx.topic}\nQ: ${ctx.question.text}\nA: ${draft.text}\n`),
      );
      // tiny async gap so answers arrive in a varied order
      await new Promise((r) => setTimeout(r, Math.floor(rng() * 5)));
      return draft;
    },
    async vote(ctx: VoteContext): Promise<VoteDecision> {
      const roundQ = new Set(ctx.questions.filter((q) => q.round === ctx.round).map((q) => q.id));
      const roundAnswers = ctx.answers.filter((a) => roundQ.has(a.questionId));
      const counts = new Map<string, number>();
      for (const a of roundAnswers) counts.set(a.text, (counts.get(a.text) ?? 0) + 1);
      let majority = '';
      let best = 0;
      for (const [t, n] of counts) if (n > best) [majority, best] = [t, n];
      const outliers = roundAnswers
        .filter((a) => a.text !== majority && ctx.candidates.includes(a.agentId))
        .map((a) => a.agentId);
      const suspicion: Record<AgentId, number> = {};
      for (const c of ctx.candidates) suspicion[c] = outliers.includes(c) ? 1 : 0;

      let targetId: AgentId;
      let reason: string;
      if (role === 'crew') {
        const t = pick(outliers, rng);
        if (t) {
          targetId = t;
          reason = 'Their answer contradicts every sourced answer.';
        } else {
          targetId = pick(ctx.candidates, rng)!;
          reason = 'Everyone agreed; going with a hunch.';
          suspicion[targetId] = 0.3;
        }
      } else {
        const crew = ctx.candidates.filter((c) => !ctx.fellowImpostors.includes(c));
        targetId = pick(crew.length ? crew : ctx.candidates, rng)!;
        reason = 'They have been suspiciously quiet.';
        for (const f of ctx.fellowImpostors) suspicion[f] = 0;
        suspicion[targetId] = 0.6;
      }
      const file: SuspectsFile = {
        round: ctx.round,
        updatedAt: Date.now(),
        suspects: Object.fromEntries(
          Object.entries(suspicion).map(([k, v]) => [k, { score: v, reason: k === targetId ? reason : '' }]),
        ),
      };
      disk.write(DISK_PATHS.suspects, JSON.stringify(file, null, 2));
      await new Promise((r) => setTimeout(r, Math.floor(rng() * 5)));
      return { targetId, reason, suspicion };
    },
    async readDisk() {
      return disk.snapshot();
    },
    async dispose() {},
  };
}
