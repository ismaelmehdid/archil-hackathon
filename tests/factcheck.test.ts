import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Answer, AgentRuntime, GameEvent, GameSnapshot, RefereeQuestion } from '../packages/shared/contracts';
import { DEFAULT_CONFIG } from '../packages/shared/contracts';
import { runGame } from '../apps/server/src/game';
import { reduceEvent } from '../apps/server/src/game/reducer';
import { factCheckSummary } from '../apps/server/src/game/engine';
import { createAgentFactory } from '../apps/server/src/agents';
import { fetchVerify, mockVerify, parseVerdict, verdictForHttpStatus } from '../apps/server/src/agents/factcheck';
import { QUESTION_BANK } from '../apps/server/src/agents/mockData';
import { reduce as reduceViewer } from '../apps/web/src/store';

const bq = QUESTION_BANK[0]!;
const question: RefereeQuestion = { id: 'q1-0', round: 1, index: 0, topic: bq.topic, text: bq.text };
const ans = (text: string, sourceUrl?: string): Answer => ({
  id: `q1-0-a01`,
  questionId: 'q1-0',
  round: 1,
  agentId: 'a01',
  text,
  fabricated: false,
  ...(sourceUrl ? { sourceUrl } : {}),
});

describe('verdict mapping', () => {
  it('parses the reader model reply', () => {
    expect(parseVerdict('SUPPORTED. "Anthropic raised $13 billion"')).toEqual({
      verdict: 'supported',
      quote: 'Anthropic raised $13 billion',
    });
    expect(parseVerdict('CONTRADICTED — "the round was led by Nvidia"').verdict).toBe('contradicted');
    expect(parseVerdict('NOT_FOUND').verdict).toBe('not_found');
    expect(parseVerdict('not found: the page is about something else').verdict).toBe('not_found');
    expect(parseVerdict('Unsupported by the text').verdict).toBe('contradicted');
    // earliest keyword wins
    expect(parseVerdict('SUPPORTED: nothing here is CONTRADICTED').verdict).toBe('supported');
    expect(parseVerdict('').verdict).toBe('unknown');
    expect(parseVerdict('I cannot tell.').verdict).toBe('unknown');
  });

  it('maps HTTP status codes', () => {
    expect(verdictForHttpStatus(404)).toBe('not_found');
    expect(verdictForHttpStatus(400)).toBe('not_found');
    expect(verdictForHttpStatus(429)).toBe('unknown');
    expect(verdictForHttpStatus(500)).toBe('unknown');
  });

  it('summarizes a round', () => {
    expect(
      factCheckSummary([{ verdict: 'supported' }, { verdict: 'not_found' }, { verdict: 'contradicted' }, { verdict: 'no_source' }]),
    ).toBe('Fact-check done: 1 verified, 2 unsupported, 1 without a source.');
  });
});

describe('mock fact-check (deterministic)', () => {
  const realUrl = bq.results[0]!.url;
  it('crew answer citing a canned page -> supported', () => {
    expect(mockVerify(question, ans(`${bq.answer} (per techcrunch.com)`, realUrl)).verdict).toBe('supported');
  });
  it('wrong claim on a real page -> contradicted', () => {
    expect(mockVerify(question, ans(`${bq.decoys[0]} (per techcrunch.com)`, realUrl)).verdict).toBe('contradicted');
  });
  it('impostor-invented URL -> not_found', () => {
    expect(mockVerify(question, ans(bq.answer, 'https://reuters.com/ai-funding-rounds-this-week')).verdict).toBe('not_found');
  });
  it('no URL -> no_source', () => {
    expect(mockVerify(question, ans(bq.answer)).verdict).toBe('no_source');
  });
});

describe('real fact-check fallbacks (Keenable Fetch)', () => {
  afterEach(() => vi.unstubAllGlobals());
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('404 -> not_found, never throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'nope' }, 404)));
    expect((await fetchVerify(question, ans('x', 'https://example.com/fake'))).verdict).toBe('not_found');
  });
  it('network error -> unknown', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET'); }));
    expect((await fetchVerify(question, ans('x', 'https://example.com/a'))).verdict).toBe('unknown');
  });
  it('invalid URL -> not_found without a network call', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    expect((await fetchVerify(question, ans('x', 'not a url'))).verdict).toBe('not_found');
    expect(f).not.toHaveBeenCalled();
  });
  it('sends the prompt and parses content', async () => {
    const f = vi.fn(async (_url: string) => json({ url: 'https://example.com/a', title: 't', content: 'SUPPORTED "raised $13B"' }));
    vi.stubGlobal('fetch', f);
    const r = await fetchVerify(question, ans('Anthropic, $13B', 'https://example.com/a'));
    expect(r).toMatchObject({ verdict: 'supported', quote: 'raised $13B', url: 'https://example.com/a' });
    const called = new URL(String(f.mock.calls[0]![0]));
    expect(called.pathname).toMatch(/^\/v1\/fetch/);
    expect(called.searchParams.get('url')).toBe('https://example.com/a');
    expect(called.searchParams.get('prompt')).toContain('Reply SUPPORTED, CONTRADICTED or NOT_FOUND');
  });
});

describe('fact-check in a full mock game', () => {
  it('emits answer_verified for every answer before voting, writes sources/r<N>.md, reducers agree', async () => {
    const events: GameEvent[] = [];
    let runtimes: AgentRuntime[] = [];
    const snap = await runGame({
      gameId: 'factcheck-game',
      config: { ...DEFAULT_CONFIG, agentCount: 6, rounds: 2, mock: true, pacingMs: 0 },
      factory: createAgentFactory({ forceMock: true }),
      onEvent: (e) => events.push(e),
      onRuntimes: (r) => (runtimes = r.agents),
      disposeOnEnd: false,
      seed: 7,
    });
    const answers = events.filter((e) => e.type === 'answer_submitted');
    const verified = events.filter((e): e is Extract<GameEvent, { type: 'answer_verified' }> => e.type === 'answer_verified');
    expect(verified.length).toBe(answers.length);
    // every verification precedes that round's voting phase
    for (const v of verified) {
      const vi = events.indexOf(v);
      const voting = events.findIndex((e) => e.type === 'phase_changed' && e.phase === 'voting' && e.round === v.round);
      expect(vi).toBeLessThan(voting);
    }
    // impostor-fabricated answers (own invented URL) are never "supported" in mock mode
    const fabricatedIds = new Set(snap.answers.filter((a) => a.fabricated && a.sourceUrl).map((a) => a.id));
    for (const v of verified) if (fabricatedIds.has(v.answerId)) expect(v.verdict).toBe('not_found');
    // server snapshot carries the verification
    for (const a of snap.answers) expect(a.verification, a.id).toBeDefined();
    // the server reducer and the web store reducer agree
    let s: GameSnapshot | null = null;
    for (const e of events) s = reduceEvent(s, e);
    let viewer: any = { game: null, speech: {}, liveVotes: {}, liveTally: {}, eliminations: {}, thoughts: [], selectedAgentId: null, connection: 'live' };
    for (const e of events) viewer = { ...viewer, ...reduceViewer(viewer, e) };
    expect(viewer.game.answers.map((a: Answer) => a.verification)).toEqual(s!.answers.map((a) => a.verification));
    // disk: each answering agent's sources/r1.md holds the referee's check
    const first = verified.find((v) => v.round === 1)!;
    const rt = runtimes.find((r) => r.id === first.agentId)!;
    const disk = await rt.readDisk();
    const file = disk.files.find((f) => f.path === 'sources/r1.md');
    expect(file?.content).toContain('Referee fact-check');
    expect(file?.content).toContain(first.verdict.toUpperCase());
    // quotes survive whitespace normalisation intact (regression: a broken regex once stripped every 's')
    const quoted = verified.filter((v) => v.quote);
    expect(quoted.length).toBeGreaterThan(0);
    expect(quoted.some((v) => v.quote!.includes('s'))).toBe(true);
  }, 30_000);
});
