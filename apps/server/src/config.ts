import { DEFAULT_CONFIG, DEFAULT_SERVER_PORT, type CreateGameRequest, type GameConfig } from '@susagent/shared';
import { normalizeConfig } from './game/engine';

const env = process.env;
const flag = (v: string | undefined) => v === '1' || v?.toLowerCase() === 'true';

export const serverEnv = {
  port: Number(env.PORT) || DEFAULT_SERVER_PORT,
  autoStart: flag(env.AUTO_START),
  agentCount: Number(env.AGENT_COUNT) || DEFAULT_CONFIG.agentCount,
  mock: flag(env.SUSAGENT_MOCK),
  /** Force the engine's built-in deterministic fake agents (no agents layer at all). */
  engineFake: flag(env.SUSAGENT_ENGINE_FAKE),
  pacingMs: env.PACING_MS !== undefined && env.PACING_MS !== '' ? Number(env.PACING_MS) : undefined,
  eliminationsPerRound: Number(env.ELIMINATIONS_PER_ROUND) || 0,
  /** 0..1, unset = contract default. */
  impostorWhisperChance:
    env.IMPOSTOR_WHISPER_CHANCE !== undefined && env.IMPOSTOR_WHISPER_CHANCE !== '' ? Number(env.IMPOSTOR_WHISPER_CHANCE) : undefined,
  /** Per agent call timeout. */
  agentTimeoutMs: Number(env.AGENT_TIMEOUT_MS) || 45_000,
  /** Delay before AUTO_START launches the next game after game_over. */
  restartDelayMs: Number(env.RESTART_DELAY_MS) || 20_000,
};

/** DEFAULT_CONFIG <- env <- request body, then clamped. */
export function buildConfig(req: CreateGameRequest = {}): GameConfig {
  const body = (req && typeof req === 'object' ? req : {}) as CreateGameRequest;
  const base: GameConfig = {
    ...DEFAULT_CONFIG,
    agentCount: serverEnv.agentCount,
    mock: serverEnv.mock,
    ...(serverEnv.eliminationsPerRound > 0 ? { eliminationsPerRound: serverEnv.eliminationsPerRound } : {}),
    ...(serverEnv.impostorWhisperChance !== undefined && Number.isFinite(serverEnv.impostorWhisperChance)
      ? { impostorWhisperChance: serverEnv.impostorWhisperChance }
      : {}),
    ...(serverEnv.pacingMs !== undefined && Number.isFinite(serverEnv.pacingMs) ? { pacingMs: serverEnv.pacingMs } : {}),
  };
  const merged: GameConfig = {
    ...base,
    ...stripUndefined(body),
    models: { ...base.models, ...(body.models ?? {}) },
  } as GameConfig;
  if (serverEnv.mock) merged.mock = true;
  return normalizeConfig(merged);
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)) as Partial<T>;
}
