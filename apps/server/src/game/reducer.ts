import type { GameEvent, GameSnapshot } from '@susagent/shared';

/**
 * Pure snapshot reducer: snapshot(n) = reduceEvent(snapshot(n-1), event n).
 * game_created resets the snapshot. Events before game_created are ignored (returns input).
 */
export function reduceEvent(prev: GameSnapshot | null, e: GameEvent): GameSnapshot {
  if (e.type === 'game_created') {
    const locations: GameSnapshot['locations'] = {};
    for (const a of e.agents) locations[a.id] = { kind: 'room', roomId: a.roomId };
    return {
      gameId: e.gameId,
      config: e.config,
      mode: e.mode,
      status: 'starting',
      round: 0,
      phase: 'lobby',
      phaseEndsAt: null,
      topic: null,
      agents: e.agents.map((a) => ({ ...a })),
      rooms: e.rooms.map((r) => ({ ...r, agentIds: [...r.agentIds] })),
      locations,
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
      lastSeq: e.seq,
    };
  }
  if (!prev) {
    throw new Error(`reduceEvent: ${e.type} before game_created`);
  }
  const s: GameSnapshot = { ...prev, lastSeq: e.seq };
  switch (e.type) {
    case 'roles_assigned':
      s.roles = { ...e.roles };
      break;
    case 'mode_updated':
      s.mode = { ...e.mode };
      break;
    case 'round_started':
      s.status = 'running';
      s.round = e.round;
      s.topic = e.topic;
      s.rooms = e.rooms.map((r) => ({ ...r, agentIds: [...r.agentIds] }));
      s.agents = e.agents.map((a) => ({ ...a }));
      break;
    case 'phase_changed':
      s.round = e.round;
      s.phase = e.phase;
      s.phaseEndsAt = e.endsAt;
      if (e.phase !== 'lobby' && e.phase !== 'game_over') s.status = 'running';
      break;
    case 'question_asked':
      s.questions = [...s.questions, e.question];
      break;
    case 'answer_key':
      s.answerKeys = [...s.answerKeys, e.key];
      break;
    case 'search_performed':
      s.searches = [...s.searches, e.search];
      break;
    case 'answer_submitted':
      s.answers = [...s.answers, e.answer];
      break;
    case 'message_posted':
      s.messages = [...s.messages, e.message];
      break;
    case 'agent_moved':
      s.locations = { ...s.locations, [e.agentId]: e.to };
      break;
    case 'vote_cast':
      s.votes = [...s.votes, e.vote];
      break;
    case 'suspicion_updated':
      s.suspicion = { ...e.scores };
      break;
    case 'agent_eliminated':
      s.agents = s.agents.map((a) => (a.id === e.agentId ? { ...a, alive: false, revealedRole: e.role } : a));
      s.rooms = s.rooms.map((r) => ({ ...r, agentIds: r.agentIds.filter((id) => id !== e.agentId) }));
      s.eliminated = [...s.eliminated, { agentId: e.agentId, role: e.role, round: e.round }];
      if (e.agentId in s.suspicion) {
        const { [e.agentId]: _drop, ...rest } = s.suspicion;
        s.suspicion = rest;
      }
      break;
    case 'game_over':
      s.status = 'over';
      s.phase = 'game_over';
      s.phaseEndsAt = null;
      s.winner = e.winner;
      s.winReason = e.reason;
      s.roles = { ...e.roles };
      break;
    default:
      break;
  }
  return s;
}
