export { runGame, normalizeConfig, type RunGameOptions } from './engine';
export { reduceEvent } from './reducer';
export {
  assignRoles,
  checkWinner,
  tallyVotes,
  pickEliminated,
  pickEliminatedMany,
  eliminationsFor,
  buildRooms,
  buildAgents,
  aliveRooms,
  agentColor,
  impostorCount,
  makeRng,
  shuffle,
  pick,
  AGENT_NAMES,
  ISLAND_NAMES,
  type Rng,
} from './rules';
export { makeWhisper } from './whisper';
export { createFakeAgentFactory, FAKE_MODE } from './fakeAgents';
export { GameManager, type GameRun, type GameManagerOptions } from './manager';
