'use client';
import { create } from 'zustand';
import {
  DEFAULT_CONFIG,
  REFEREE_ID,
  type AgentLocation,
  type GameEvent,
  type GameSnapshot,
  type ViewerState,
} from '@susagent/shared';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

type Data = Pick<
  ViewerState,
  'game' | 'speech' | 'liveVotes' | 'liveTally' | 'eliminations' | 'thoughts' | 'selectedAgentId' | 'connection'
>;

const emptyData = (): Omit<Data, 'connection'> => ({
  game: null,
  selectedAgentId: null,
  speech: {},
  liveVotes: {},
  liveTally: {},
  eliminations: {},
  thoughts: [],
});

/** Placeholder snapshot when an event arrives before game_created (should not happen). */
function blankGame(gameId: string): GameSnapshot {
  return {
    gameId,
    config: DEFAULT_CONFIG,
    mode: { llm: 'mock', disks: 'memory', search: 'mock', impostorEgressBlocked: false },
    status: 'starting',
    round: 0,
    phase: 'lobby',
    phaseEndsAt: null,
    topic: null,
    agents: [],
    rooms: [],
    locations: {},
    roles: {},
    questions: [],
    answerKeys: [],
    answers: [],
    votes: [],
    searches: [],
    messages: [],
    suspicion: {},
    eliminated: [],
    winner: null,
    winReason: null,
    lastSeq: 0,
  };
}

/** Pure reducer: (state, event) -> partial state. */
export function reduce(s: Data, e: GameEvent): Partial<Data> {
  if (e.type === 'game_created') {
    // SSE reconnect replays from seq 1: don't wipe a game we already have
    if (s.game && s.game.gameId === e.gameId && e.seq <= s.game.lastSeq) return {};
    const g = blankGame(e.gameId);
    const locations: Record<string, AgentLocation> = {};
    for (const a of e.agents) locations[a.id] = { kind: 'room', roomId: a.roomId };
    return {
      ...emptyData(),
      game: {
        ...g,
        config: e.config,
        mode: e.mode,
        agents: e.agents,
        rooms: e.rooms,
        locations,
        lastSeq: e.seq,
      },
    };
  }

  const g0 = s.game ?? blankGame(e.gameId);
  // ignore events for a different game (stale stream) and duplicates
  if (s.game && e.gameId !== s.game.gameId) return {};
  if (s.game && e.seq <= s.game.lastSeq) return {};
  const g: GameSnapshot = { ...g0, lastSeq: e.seq };
  const at = now();
  const out: Partial<Data> = { game: g };

  switch (e.type) {
    case 'roles_assigned':
      g.roles = e.roles;
      break;
    case 'agent_ready':
      break;
    case 'mode_updated':
      g.mode = e.mode;
      break;
    case 'round_started':
      g.status = 'running';
      g.round = e.round;
      g.topic = e.topic;
      g.rooms = e.rooms;
      g.agents = e.agents;
      out.liveVotes = {};
      out.liveTally = {};
      break;
    case 'phase_changed':
      g.round = e.round || g.round;
      g.phase = e.phase;
      g.phaseEndsAt = e.endsAt;
      if (e.phase !== 'lobby' && e.phase !== 'game_over') g.status = 'running';
      break;
    case 'question_asked':
      g.questions = [...g.questions, e.question];
      g.topic = e.question.topic || g.topic;
      out.speech = { ...s.speech, [REFEREE_ID]: { id: e.question.id, text: e.question.text, at } };
      break;
    case 'answer_key':
      g.answerKeys = [...g.answerKeys, e.key];
      break;
    case 'search_performed':
      g.searches = [...g.searches, e.search];
      break;
    case 'search_denied':
      break;
    case 'answer_submitted':
      g.answers = [...g.answers, e.answer];
      out.speech = { ...s.speech, [e.answer.agentId]: { id: e.answer.id, text: e.answer.text, at } };
      break;
    case 'answer_verified': {
      const v = { verdict: e.verdict, ...(e.url ? { url: e.url } : {}), ...(e.quote ? { quote: e.quote } : {}) };
      g.answers = g.answers.map((a) => (a.id === e.answerId ? { ...a, verification: v } : a));
      break;
    }
    case 'agent_thought': {
      const t = [...s.thoughts, e];
      out.thoughts = t.length > 200 ? t.slice(t.length - 200) : t;
      break;
    }
    case 'message_posted':
      g.messages = [...g.messages, e.message];
      out.speech = { ...s.speech, [e.message.agentId]: { id: e.message.id, text: e.message.text, at } };
      break;
    case 'agent_moved':
      g.locations = { ...g.locations, [e.agentId]: e.to };
      break;
    case 'vote_cast':
      g.votes = [...g.votes, e.vote];
      out.liveVotes = {
        ...s.liveVotes,
        [e.vote.voterId]: { voterId: e.vote.voterId, targetId: e.vote.targetId, reason: e.vote.reason, at },
      };
      out.liveTally = e.tally;
      break;
    case 'suspicion_updated':
      g.suspicion = e.scores;
      break;
    case 'copy_suspected':
      g.copySuspicions = [
        ...(g.copySuspicions ?? []),
        { round: e.round, agentId: e.agentId, fromAgentId: e.fromAgentId, phrase: e.phrase, via: e.via },
      ];
      break;
    case 'disk_updated':
      break;
    case 'agent_eliminated':
      g.agents = g.agents.map((a) => (a.id === e.agentId ? { ...a, alive: false, revealedRole: e.role } : a));
      g.rooms = g.rooms.map((r) => ({ ...r, agentIds: r.agentIds.filter((id) => id !== e.agentId) }));
      g.eliminated = [...g.eliminated, { agentId: e.agentId, role: e.role, round: e.round }];
      out.liveTally = e.tally;
      out.eliminations = { ...s.eliminations, [e.agentId]: { role: e.role, at } };
      break;
    case 'game_over':
      g.status = 'over';
      g.phase = 'game_over';
      g.phaseEndsAt = null;
      g.winner = e.winner;
      g.winReason = e.reason;
      g.roles = e.roles;
      break;
    case 'log':
      break;
  }
  return out;
}

export const useViewerStore = create<ViewerState>()((set, get) => ({
  ...emptyData(),
  source: 'live',
  connection: 'idle',
  godMode: false,
  replaySpeed: 1,

  setGodMode: (on) => set({ godMode: on }),
  selectAgent: (id) => set({ selectedAgentId: id }),
  setSource: (source) => set({ source }),
  setReplaySpeed: (x) => set({ replaySpeed: x }),
  applyEvent: (e) => {
    const patch = reduce(get(), e);
    if (Object.keys(patch).length) set(patch);
  },
  reset: () => set({ ...emptyData() }),
}));

/** Non-contract helper for the UI: set connection status. */
export const setConnection = (c: ViewerState['connection']) => useViewerStore.setState({ connection: c });
