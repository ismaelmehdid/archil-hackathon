import { describe, expect, it } from 'vitest';
import type { Answer } from '../packages/shared/contracts';
import { MemoryCouncil, agentOfPath, candidatePhrases, councilPath, phrasePattern } from '../apps/server/src/agents/council';
import { runGame } from '../apps/server/src/game/engine';
import { createFakeAgentFactory } from '../apps/server/src/game/fakeAgents';
import { DEFAULT_CONFIG, type GameEvent } from '../packages/shared/contracts';

const ans = (agentId: string, text: string, i: number, sourceUrl?: string): Answer => ({
  id: `q1-0-${agentId}-${i}`,
  questionId: 'q1-0',
  round: 1,
  agentId,
  text,
  fabricated: false,
  ...(sourceUrl ? { sourceUrl } : {}),
});

describe('council copy detector (mock / in-memory path)', () => {
  const question = 'Which company announced the largest chip deal this week?';

  it('flags a later answer that shares a distinctive phrase with exactly one earlier answer', async () => {
    const c = new MemoryCouncil();
    const answers = [
      ans('agent-01', 'Nvidia signed a $5 billion supply deal with Samsung, per reuters.com', 0, 'https://reuters.com/x'),
      ans('agent-02', 'Intel said it would cut 15,000 jobs after weak earnings.', 1),
      ans('agent-03', 'AMD reported record data center revenue (per theverge.com)', 2),
      ans('agent-04', 'Pretty sure it is Nvidia — a $5 billion supply deal with Samsung.', 3),
    ];
    for (const a of answers) await c.writeAnswer(a);
    expect(c.files.get(councilPath(1, 'agent-01'))).toContain('[https://reuters.com/x]');

    const flags = await c.detectCopies(1, answers, question);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ round: 1, agentId: 'agent-04', fromAgentId: 'agent-01', via: 'regex' });
    expect(flags[0]!.phrase.split(' ').length).toBeGreaterThanOrEqual(3);
  });

  it('does not flag phrases everybody shares (consensus) or that come from the question', async () => {
    const c = new MemoryCouncil();
    const answers = [
      ans('agent-01', 'The largest chip deal: Broadcom and OpenAI custom accelerators.', 0),
      ans('agent-02', 'Broadcom and OpenAI custom accelerators, according to ft.com.', 1),
      ans('agent-03', 'It is Broadcom and OpenAI custom accelerators.', 2),
      ans('agent-04', 'Which company announced the largest chip deal? Qualcomm.', 3),
    ];
    for (const a of answers) await c.writeAnswer(a);
    expect(await c.detectCopies(1, answers, question)).toEqual([]);
  });

  it('infers direction from content containment, not reveal order (sealed + shuffled reveal)', async () => {
    const c = new MemoryCouncil();
    const answers = [
      // Whispered gist revealed FIRST: still the copier, since its content is a subset of the source.
      ans('agent-05', 'Heard it was a $5 billion supply deal with Samsung.', 0),
      ans('agent-02', 'Intel said it would cut 15,000 jobs after weak earnings.', 1),
      ans('agent-01', 'Nvidia signed a $5 billion supply deal with Samsung for HBM4 memory, per reuters.com', 2),
    ];
    for (const a of answers) await c.writeAnswer(a);
    const flags = await c.detectCopies(1, answers, question);
    expect(flags).toEqual([expect.objectContaining({ agentId: 'agent-05', fromAgentId: 'agent-01' })]);
  });

  it('phrase pattern uses explicit ASCII boundaries, so ripgrep and JS agree with the tokenizer', () => {
    const re = new RegExp(phrasePattern('rich bank deal'), 'i');
    // The tokenizer splits 'Zürich' into 'z' + 'rich'; [^a-z0-9] boundaries match that in both engines.
    expect(re.test('Zürich bank deal')).toBe(true);
    expect(re.test('Ostrich bank deal')).toBe(false);
    expect(re.test('the Rich bank deal')).toBe(true);
  });

  it('extracts n-grams and maps council paths back to agents', () => {
    expect(candidatePhrases('Nvidia signed a $5 billion deal', 'unrelated')).toContain('5 billion deal');
    expect(agentOfPath('r2/agent-07.md')).toBe('agent-07');
    expect(agentOfPath('agent-07.md')).toBe('agent-07');
  });

  it('engine emits copy_suspected before voting and passes flags into the vote context', async () => {
    const events: GameEvent[] = [];
    await runGame({
      config: { ...DEFAULT_CONFIG, agentCount: 8, rounds: 3, pacingMs: 0 },
      factory: createFakeAgentFactory(7),
      seed: 7,
      onEvent: (e) => events.push(e),
    });
    const flags = events.filter((e) => e.type === 'copy_suspected');
    for (const f of flags) {
      const firstVote = events.find((e) => e.type === 'vote_cast' && e.vote.round === f.round);
      expect(firstVote ? firstVote.seq : Infinity).toBeGreaterThan(f.seq);
      expect(f.agentId).not.toBe(f.fromAgentId);
    }
    expect(events.at(-1)?.type).toBe('game_over');
  });
});
