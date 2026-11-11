import { describe, expect, it } from 'vitest';
import type {
  AgentFactory,
  AgentRuntime,
  Answer,
  AnswerContext,
  GameConfig,
  GameEvent,
  Role,
} from '../packages/shared/contracts';
import { DEFAULT_CONFIG } from '../packages/shared/contracts';
import { createFakeAgentFactory, makeWhisper, runGame } from '../apps/server/src/game';
import { createAgentFactory } from '../apps/server/src/agents';

const URL_RE = /(https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(com|net|org|io|ai|dev|news|gov|edu)(\/\S*)?/i;

describe('makeWhisper', () => {
  it('strips URLs, numbers, dates and money', () => {
    const cases = [
      'It was Linux 6.18, released Nov 9 2026 per https://lwn.net/Articles/123 — big release.',
      'SpaceX raised $1.5B on 2026-11-03, see www.reuters.com/tech for details.',
      'Anthropic announced €200 million funding on 3 November, says techcrunch.com/2026/11/03/x',
      'The Starship flight 12 launched on 11/08/2026 from Boca Chica.',
    ];
    for (const text of cases) {
      const w = makeWhisper(text);
      if (w === null) continue; // allowed to give up, but if it returns text it must be clean
      expect(w, `whisper of: ${text}`).not.toMatch(URL_RE);
      // standalone numbers are gone (a digit glued to a name like GPT-5 is allowed)
      expect(w, `whisper of: ${text}`).not.toMatch(/(?<![A-Za-z]-?)\b\d+([.,:/-]\d+)*\b/);
      expect(w, `whisper of: ${text}`).not.toMatch(/[$€£¥]/);
      expect(w, `whisper of: ${text}`).not.toMatch(
        /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)(uary|ruary|ch|il|e|y|ust|tember|ober|ember)?\b/i,
      );
      expect(w.trim().length).toBeGreaterThan(0);
    }
  });

  it('keeps the gist: the named entity survives', () => {
    const cases: [string, string][] = [
      ['Fal announced a $1.3B Series F this week', 'Fal'],
      ['Linux 6.18 shipped this week per https://lwn.net/Articles/123', 'Linux'],
      ['SpaceX raised $1.5B on 2026-11-03', 'SpaceX'],
      ['Northwind AI, $120M Series B, led by Sequoia. https://example.com/x', 'Northwind AI'],
      ["On November 10, 2026, n8n's open-source agent 'Nod' launched (per techcrunch.com)", 'Nod'],
      ['TSMC said 2nm output rose 30% (reuters.com)', 'TSMC'],
    ];
    for (const [text, entity] of cases) {
      const w = makeWhisper(text);
      expect(w, text).not.toBeNull();
      expect(w!, text).toContain(entity);
      expect(w!, text).not.toMatch(/\$|1\.3|1\.5|2026|lwn/);
    }
  });

  it('returns null when nothing usable is left', () => {
    for (const text of ['', '   ', 'https://example.com/a/b', '$1,200 on 2026-11-03', '42', '11/08/2026 https://x.io', 'I believe it was 400 Wh/kg, up 12% year over year.', "I'm not sure.", 'about 22 broadband satellites']) {
      expect(makeWhisper(text), JSON.stringify(text)).toBeNull();
    }
  });
});

/** Wrap a factory so we can see, in one ordered log, when each answer() resolves vs. which events are emitted. */
type LogItem =
  | { kind: 'called'; agentId: string; questionId: string; role: Role }
  | { kind: 'answered'; agentId: string; questionId: string; role: Role }
  | { kind: 'event'; e: GameEvent };

function instrument(inner: AgentFactory, log: LogItem[], ctxs: AnswerContext[]): AgentFactory {
  return {
    mode: inner.mode,
    async createAll(input) {
      const res = await inner.createAll(input);
      const agents: AgentRuntime[] = res.agents.map((rt) => ({
        get id() { return rt.id; },
        get role() { return rt.role; },
        get hasWebSearch() { return rt.hasWebSearch; },
        async answer(ctx) {
          ctxs.push(ctx);
          log.push({ kind: 'called', agentId: rt.id, questionId: ctx.question.id, role: rt.role });
          const d = await rt.answer(ctx);
          log.push({ kind: 'answered', agentId: rt.id, questionId: ctx.question.id, role: rt.role });
          return d;
        },
        vote: (ctx) => rt.vote(ctx),
        readDisk: () => rt.readDisk(),
        dispose: () => rt.dispose(),
      }));
      return { referee: res.referee, agents };
    },
  };
}

async function playInstrumented(factory: AgentFactory, seed: number, over: Partial<GameConfig> = {}) {
  const log: LogItem[] = [];
  const ctxs: AnswerContext[] = [];
  const events: GameEvent[] = [];
  await runGame({
    gameId: `sealed-${seed}`,
    config: { ...DEFAULT_CONFIG, agentCount: 12, mock: true, pacingMs: 0, ...over },
    factory: instrument(factory, log, ctxs),
    onEvent: (e) => {
      events.push(e);
      log.push({ kind: 'event', e });
    },
    seed,
  });
  const rolesEv = events.find((e) => e.type === 'roles_assigned');
  const roles = rolesEv?.type === 'roles_assigned' ? rolesEv.roles : {};
  const answersByQ = new Map<string, Answer[]>();
  for (const e of events) {
    if (e.type !== 'answer_submitted') continue;
    const list = answersByQ.get(e.answer.questionId) ?? [];
    list.push(e.answer);
    answersByQ.set(e.answer.questionId, list);
  }
  return { log, ctxs, events, roles, answersByQ };
}

const factories: [string, (seed: number) => AgentFactory][] = [
  ['engine fake factory', (seed) => createFakeAgentFactory(seed)],
  ['agents mock factory', () => createAgentFactory({ forceMock: true })],
];

describe.each(factories)('sealed answers (%s)', (_name, mk) => {
  it('no answer is revealed before every alive agent has answered that question', async () => {
    for (const seed of [1, 2, 3]) {
      const { log } = await playInstrumented(mk(seed), seed, { impostorWhisperChance: 1 });
      const qids = new Set(log.flatMap((l) => (l.kind === 'answered' ? [l.questionId] : [])));
      expect(qids.size).toBeGreaterThan(0);
      for (const qid of qids) {
        const lastAnswered = log.map((l) => l.kind === 'answered' && l.questionId === qid).lastIndexOf(true);
        const firstReveal = log.findIndex((l) => l.kind === 'event' && l.e.type === 'answer_submitted' && l.e.answer.questionId === qid);
        expect(firstReveal, `seed ${seed} ${qid}: an answer was revealed before all were collected`).toBeGreaterThan(lastAnswered);
      }
    }
  });

  it('impostors are asked only after every crew answer for that question has resolved', async () => {
    for (const seed of [6, 7]) {
      const { log } = await playInstrumented(mk(seed), seed, { impostorWhisperChance: 1 });
      const qids = new Set(log.flatMap((l) => (l.kind === 'called' ? [l.questionId] : [])));
      for (const qid of qids) {
        const lastCrewDone = log.map((l) => l.kind === 'answered' && l.role === 'crew' && l.questionId === qid).lastIndexOf(true);
        const firstImpCall = log.findIndex((l) => l.kind === 'called' && l.role === 'impostor' && l.questionId === qid);
        if (firstImpCall >= 0) expect(firstImpCall, `seed ${seed} ${qid}`).toBeGreaterThan(lastCrewDone);
      }
    }
  });

  it('agents never see answers to the current question in their context', async () => {
    const { ctxs } = await playInstrumented(mk(4), 4, { impostorWhisperChance: 1 });
    expect(ctxs.length).toBeGreaterThan(0);
    for (const ctx of ctxs) {
      expect(ctx.answers.filter((a) => a.questionId === ctx.question.id), `${ctx.self.id} ${ctx.question.id}`).toEqual([]);
      const revealed = (ctx as { revealedForThisQuestion?: Answer[] }).revealedForThisQuestion;
      if (revealed) expect(revealed).toEqual([]);
    }
  });

  it('whispers go to impostors only and never contain a URL', async () => {
    const { ctxs, roles } = await playInstrumented(mk(5), 5, { impostorWhisperChance: 1 });
    let whispers = 0;
    for (const ctx of ctxs) {
      if (!ctx.whisper) continue;
      whispers++;
      expect(roles[ctx.self.id], `${ctx.self.id} got a whisper`).toBe('impostor');
      expect(ctx.whisper.text).not.toMatch(URL_RE);
      expect(roles[ctx.whisper.fromAgentId]).toBe('crew');
    }
    expect(whispers, 'impostorWhisperChance=1 should produce whispers').toBeGreaterThan(0);

    const none = await playInstrumented(mk(5), 5, { impostorWhisperChance: 0 });
    expect(none.ctxs.filter((c) => c.whisper)).toEqual([]);
  });

  it('reveal order is shuffled: impostors are not always revealed last', async () => {
    let questions = 0;
    let impostorNotLast = 0;
    for (const seed of [11, 12, 13, 14, 15, 16, 17, 18]) {
      const { answersByQ, roles } = await playInstrumented(mk(seed), seed);
      for (const answers of answersByQ.values()) {
        const flags = answers.map((a) => roles[a.agentId] === 'impostor');
        if (!flags.includes(true) || !flags.includes(false)) continue;
        questions++;
        const firstImp = flags.indexOf(true);
        const impostorsLast = flags.slice(firstImp).every(Boolean);
        if (!impostorsLast) impostorNotLast++;
      }
    }
    expect(questions).toBeGreaterThan(0);
    expect(impostorNotLast, `impostors were revealed last in all ${questions} questions`).toBeGreaterThan(0);
  });

  it("impostor answers never reuse a URL from a crew answer to the same question", async () => {
    for (const seed of [21, 22, 23]) {
      const { answersByQ, roles } = await playInstrumented(mk(seed), seed, { impostorWhisperChance: 1 });
      for (const [qid, answers] of answersByQ) {
        const crewUrls = new Set(answers.filter((a) => roles[a.agentId] === 'crew' && a.sourceUrl).map((a) => a.sourceUrl!));
        for (const a of answers) {
          if (roles[a.agentId] !== 'impostor' || !a.sourceUrl) continue;
          expect(crewUrls.has(a.sourceUrl), `seed ${seed} ${qid}: impostor ${a.agentId} reused ${a.sourceUrl}`).toBe(false);
        }
      }
    }
  });
});
