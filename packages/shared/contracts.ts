/**
 * SusAgent — shared contracts (v2: referee format).
 *
 * Single source of truth for every package (server engine, agents, web UI, 3D scene, QA).
 * OWNER: lead/reviewer. Teammates must NOT edit this file — message the lead to request changes.
 *
 * Game flow (5 rounds by default):
 *   lobby -> [ round_started -> question -> answering -> voting -> reveal ] x N -> game_over
 *   - question:  the REFEREE agent asks a question about this round's (recent-news) topic.
 *   - answering: SEALED. Every alive agent answers without seeing anyone else's answer to this
 *                question; all answers are revealed afterwards in SHUFFLED order. Crew may web_search
 *                (budget per round) and must cite only URLs their own searches returned. Impostors have
 *                NO search tool: they invent a plausible answer + source, helped sometimes by a vague
 *                "whisper" (see GameConfig.impostorWhisperChance).
 *   - voting:    every alive agent votes publicly for who it thinks is an impostor. Crew may spend
 *                leftover search budget to verify suspicious claims/sources before voting. Votes
 *                stream one by one in real time (vote_cast) so viewers see who votes for whom.
 *   Balance target ("hard to guess, not impossible"): crew win rate ~40-60% at 12 agents.
 *   - reveal:    the most-voted agent is eliminated and its role revealed.
 *   Crew wins when all impostors are out. Impostors win at parity (impostors >= crew) or if any
 *   impostor survives the last round.
 *
 * Conventions
 * - Ids: agents "a01".."a50", rooms "r1".."r9", the referee is REFEREE_ID ("referee").
 * - `ts` on live events = epoch ms. In fixtures/replay.json `ts` = ms offset from game start.
 *   Consumers must only use ts DIFFERENCES (never compare to Date.now()).
 * - Fields marked GOD-ONLY are streamed to every client; the web UI hides them unless god mode is on.
 * - Rooms are now only a LAYOUT grouping (which island an agent stands on). All play is global.
 */

/* ------------------------------------------------------------------ */
/* Primitives                                                          */
/* ------------------------------------------------------------------ */

export type AgentId = string;
export type RoomId = string;
export type Role = 'crew' | 'impostor';
export type Winner = 'crew' | 'impostor';

/** The referee is not a player: never in agents[], never votes, cannot be voted. */
export const REFEREE_ID = 'referee';

export type Phase =
  | 'lobby' // disks/sandboxes being provisioned in parallel
  | 'question' // referee is asking
  | 'answering' // agents answer (answers stream in as they finish)
  | 'voting' // agents walk to the council island; votes stream in live
  | 'reveal' // eliminated agent falls off, role revealed
  | 'game_over';

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

export interface ModelConfig {
  /** Cheap fast model for crewmates. */
  crew: string;
  /** Stronger model for impostors (they must invent convincing answers). */
  impostor: string;
  /** Model for the referee (question writer). */
  referee: string;
}

export interface GameConfig {
  /** Number of player agents (referee not counted). Default 12, min 6, max MAX_AGENTS. */
  agentCount: number;
  /** Agents per island (layout only). Default 6. */
  roomSize: number;
  /** impostorCount = max(1, round(agentCount * impostorRatio)). Default 1/6. */
  impostorRatio: number;
  /** Number of rounds. Default 5. */
  rounds: number;
  /** Referee questions per round. Default 1. */
  questionsPerRound: number;
  /**
   * Agents eliminated per round (top-k of the tally, ties random). 0 = auto:
   * max(1, ceil(impostorCount * 1.5 / rounds)) -> 1 for 12 agents, 3 for 50 agents, so large
   * games stay winnable for the crew within `rounds`. One agent_eliminated event per eliminated agent.
   */
  eliminationsPerRound: number;
  /** Web searches a crewmate may use per round (answering + verification while voting). Default 3. */
  searchBudgetPerRound: number;
  /**
   * BALANCE KNOB. Per question, per impostor: chance (0..1) to receive a "whisper", a vague
   * text-only paraphrase of ONE random crew answer to this question (no URL, no name, may be a
   * wrong crew answer). 0 = impostors always answer blind (easy to catch); 1 = always hinted
   * (hard). The whisper keeps only the gist: key name/entity, no numbers, dates or URL. Default 0.5.
   */
  impostorWhisperChance: number;
  /** Max answer length in characters the engine accepts (truncates beyond). Default 280. */
  maxAnswerChars: number;
  /** Minimum ms between visible beats (answers revealed, votes cast) so humans can follow. Default 700. */
  pacingMs: number;
  /** Force mock mode (in-memory disks, canned search, scripted brains). */
  mock: boolean;
  models: ModelConfig;
  /** Topic pool; one is drawn per round (no repeats until exhausted). */
  topics: string[];
}

export const MAX_AGENTS = 50;
export const MIN_AGENTS = 6;

export const DEFAULT_CONFIG: GameConfig = {
  agentCount: 12,
  roomSize: 6,
  impostorRatio: 1 / 6,
  rounds: 5,
  questionsPerRound: 1,
  eliminationsPerRound: 0,
  searchBudgetPerRound: 3,
  impostorWhisperChance: 0.5,
  maxAnswerChars: 280,
  pacingMs: 700,
  mock: false,
  models: {
    crew: 'gpt-5-nano', // cheapest tier; confirmed by a real call in apps/server/src/agents
    impostor: 'gpt-5-mini',
    referee: 'gpt-5-mini',
  },
  topics: [
    'AI funding rounds this week',
    'Space launches this month',
    'Electric vehicle battery breakthroughs',
    'Major open-source software releases this week',
    'Climate and energy policy news this week',
    'Big tech antitrust cases this month',
    'Semiconductor industry news this week',
    'Notable cybersecurity incidents this month',
  ],
};

/* ------------------------------------------------------------------ */
/* Agents, rooms, locations                                            */
/* ------------------------------------------------------------------ */

/** Everything any viewer/agent may know about a player agent. */
export interface AgentPublic {
  id: AgentId;
  /** Short display name, unique in the game. */
  name: string;
  /** Hex color "#rrggbb", distinct per agent. */
  color: string;
  /** Home island. */
  roomId: RoomId;
  /** 0-based index within its island (seating). */
  seat: number;
  alive: boolean;
  /** Set once the agent is eliminated. */
  revealedRole?: Role;
}

/** Server-side truth about an agent. GOD-ONLY when streamed. */
export interface AgentSecret {
  id: AgentId;
  role: Role;
  model: string;
}

/** Island grouping for the 3D layout. */
export interface Room {
  id: RoomId;
  /** 0-based, stable for the whole game (3D places island #index on the ring). */
  index: number;
  name: string;
  /** Alive members, in seat order. */
  agentIds: AgentId[];
}

/** Where an agent physically is in the arena. The referee always stands at the council center. */
export type AgentLocation =
  | { kind: 'room'; roomId: RoomId }
  | { kind: 'council' }
  | { kind: 'void' }; // eliminated — fell off

/* ------------------------------------------------------------------ */
/* Questions, answers, searches, votes, suspicion                      */
/* ------------------------------------------------------------------ */

export interface RefereeQuestion {
  id: string; // `q${round}-${n}`
  round: number;
  /** 0-based index within the round. */
  index: number;
  topic: string;
  text: string;
}

/** GOD-ONLY: what the referee believes the true answer is. */
export interface AnswerKey {
  questionId: string;
  answer: string;
  sources: string[];
}

export interface Answer {
  id: string; // `${questionId}-${agentId}`
  questionId: string;
  round: number;
  agentId: AgentId;
  text: string;
  /** URL the agent cites. Impostors may invent one. */
  sourceUrl?: string;
  /** GOD-ONLY ground truth: true if invented by an impostor (false if crew or copied). */
  fabricated: boolean;
  /** GOD-ONLY: impostor copied this agent's revealed answer. */
  copiedFrom?: AgentId;
  /** PUBLIC: the referee's Keenable Fetch check of sourceUrl (set by answer_verified, before voting). */
  verification?: SourceCheck;
}

/**
 * Referee fact-check of a cited source (Keenable Fetch with a prompt).
 * supported / contradicted: the page exists and does / does not back the claim.
 * not_found: no page at that URL (HTTP 404/400) or the page doesn't mention it — strong "fabricated" signal.
 * unknown: the check itself failed (timeout, network, quota). no_source: the answer cited no URL.
 */
export type SourceVerdict = 'supported' | 'contradicted' | 'not_found' | 'unknown' | 'no_source';

export interface SourceCheck {
  verdict: SourceVerdict;
  url?: string;
  /** One short quote from the page (or why the check failed). */
  quote?: string;
}

/**
 * Archil grep copy detector: answer `agentId` shares a distinctive phrase with `fromAgentId`'s
 * EARLIER-revealed answer this round (and with no other answer). Public evidence for voting.
 */
export interface CopySuspicion {
  round: number;
  /** Suspected copier (revealed later). */
  agentId: AgentId;
  /** Agent whose earlier answer contains the same phrase. */
  fromAgentId: AgentId;
  /** The shared phrase (lowercased n-gram). */
  phrase: string;
  /** 'archil-grep' = disk.grep on the council disk; 'regex' = in-memory scan (mock / grep fallback). */
  via: 'archil-grep' | 'regex';
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchRecord {
  agentId: AgentId; // may be REFEREE_ID
  round: number;
  query: string;
  results: SearchResult[];
  /** Searches left for this agent this round. */
  budgetRemaining: number;
  /** True if served from canned mock results. */
  mock: boolean;
}

export interface Vote {
  round: number;
  voterId: AgentId;
  targetId: AgentId;
  /** One short public sentence. */
  reason: string;
}

/** targetId -> number of votes. */
export type Tally = Record<AgentId, number>;

/** Shape of each agent's suspects.json on its disk. */
export interface SuspectsFile {
  round: number;
  updatedAt: number;
  suspects: Record<AgentId, { score: number; reason: string }>; // score 0..1
}

/** Short free-text chat line (referee announcements, agent quips). Shown as a speech bubble. */
export interface Message {
  id: string;
  round: number;
  agentId: AgentId; // may be REFEREE_ID
  kind: 'announcement' | 'answer' | 'vote' | 'chat';
  text: string;
  ts: number;
}

/* ------------------------------------------------------------------ */
/* Disk                                                                */
/* ------------------------------------------------------------------ */

/**
 * Per-agent disk layout (Archil disk, or in-memory in mock mode):
 *   /answers.md          every question + own answer, newest round first
 *   /suspects.json       SuspectsFile (updated each voting phase)
 *   /notes.md            free-form private notes (impostor strategy lives here)
 *   /sources/r<N>.md     raw search results used in round N (crew only), plus the referee's
 *                        fact-check of this agent's cited source (every agent)
 */
export const DISK_PATHS = {
  answers: 'answers.md',
  suspects: 'suspects.json',
  notes: 'notes.md',
  sourcesDir: 'sources',
} as const;

export interface DiskFile {
  path: string;
  content: string;
}

export interface DiskSnapshot {
  agentId: AgentId;
  files: DiskFile[];
  /** 'archil' = real Archil disk, 'memory' = mock in-memory disk. */
  backend: 'archil' | 'memory';
  diskId?: string;
}

/* ------------------------------------------------------------------ */
/* Game snapshot (what GET /api/games/:id returns)                     */
/* ------------------------------------------------------------------ */

export interface ModeInfo {
  llm: 'openai' | 'mock';
  disks: 'archil' | 'memory';
  /** Provider cascade: keenable (KEENABLE_API_KEY, else public endpoint) > linkup > exa > tavily > mock. */
  search: 'keenable' | 'linkup' | 'exa' | 'tavily' | 'mock';
  /** Whether impostor sandboxes have network egress blocked at the sandbox level. */
  impostorEgressBlocked: boolean;
}

export interface GameSnapshot {
  gameId: string;
  config: GameConfig;
  mode: ModeInfo;
  status: 'starting' | 'running' | 'over';
  round: number; // 0 before the first round
  phase: Phase;
  /** Estimated end of current phase (epoch ms), null if open-ended. */
  phaseEndsAt: number | null;
  topic: string | null;
  agents: AgentPublic[];
  rooms: Room[];
  locations: Record<AgentId, AgentLocation>;
  /** GOD-ONLY. */
  roles: Record<AgentId, Role>;
  questions: RefereeQuestion[];
  /** GOD-ONLY. */
  answerKeys: AnswerKey[];
  answers: Answer[];
  votes: Vote[];
  searches: SearchRecord[];
  messages: Message[];
  /** Public aggregate suspicion 0..1 per alive agent. */
  suspicion: Record<AgentId, number>;
  /** Archil grep copy flags (all rounds). Optional: absent in older replays. */
  copySuspicions?: CopySuspicion[];
  eliminated: { agentId: AgentId; role: Role; round: number }[];
  winner: Winner | null;
  winReason: string | null;
  lastSeq: number;
}

/* ------------------------------------------------------------------ */
/* Events (SSE stream)                                                 */
/* ------------------------------------------------------------------ */

export type GameEventPayload =
  /** First event of every game. */
  | {
      type: 'game_created';
      config: GameConfig;
      mode: ModeInfo;
      agents: AgentPublic[];
      rooms: Room[];
    }
  /** GOD-ONLY. Emitted right after game_created. Impostors know each other. */
  | { type: 'roles_assigned'; roles: Record<AgentId, Role>; models: Record<AgentId, string> }
  /** One per agent (and one for REFEREE_ID) as disks/sandboxes finish provisioning in parallel. */
  | { type: 'agent_ready'; agentId: AgentId; backend: 'archil' | 'memory'; diskId?: string }
  /**
   * Final ModeInfo once provisioning finished (after all agent_ready, before round 1). Replaces
   * snapshot.mode — e.g. impostorEgressBlocked only becomes true once firewalls are verified.
   */
  | { type: 'mode_updated'; mode: ModeInfo }
  | { type: 'round_started'; round: number; topic: string; rooms: Room[]; agents: AgentPublic[] }
  | { type: 'phase_changed'; round: number; phase: Phase; endsAt: number | null }
  /** Referee asks. 3D: speech bubble above the referee. */
  | { type: 'question_asked'; question: RefereeQuestion }
  /** GOD-ONLY. Right after question_asked. */
  | { type: 'answer_key'; key: AnswerKey }
  /** Crew/referee only (impostors have no search tool, so they can never produce this). */
  | { type: 'search_performed'; search: SearchRecord }
  /** A crewmate tried to search with no budget left. */
  | { type: 'search_denied'; agentId: AgentId; round: number; query: string; reason: 'budget_exhausted' }
  /** An agent's answer is revealed. 3D: speech bubble above the agent for ~3 s. */
  | { type: 'answer_submitted'; answer: Answer }
  /**
   * PUBLIC evidence (reveals no roles): the referee fetched the answer's cited URL and judged the claim.
   * One per answer, after all answers to a question are revealed and before voting. Sets answer.verification.
   */
  | {
      type: 'answer_verified';
      answerId: string;
      agentId: AgentId;
      round: number;
      url?: string;
      verdict: SourceVerdict;
      quote?: string;
    }
  /** GOD-ONLY private reasoning (impostor strategy, crew hunches). */
  | { type: 'agent_thought'; agentId: AgentId; round: number; phase: Phase; text: string }
  /** Referee announcements / misc chat. 3D: speech bubble. */
  | { type: 'message_posted'; message: Message }
  /** 3D: lerp the agent to its new location. 'void' = falling off (see agent_eliminated). */
  | { type: 'agent_moved'; agentId: AgentId; to: AgentLocation }
  /**
   * LIVE vote, one event per voter, streamed during 'voting' with >= pacingMs spacing.
   * 3D: draw a beam voter -> target in the voter's color; UI: update the live who-votes-whom table.
   */
  | { type: 'vote_cast'; vote: Vote; tally: Tally }
  /** Referee's Archil grep over the shared council disk (r<N>/) flagged a likely copy. After answering, before voting. */
  | ({ type: 'copy_suspected' } & CopySuspicion)
  /** Public aggregate suspicion 0..1 (mean of alive agents' suspects.json scores). 3D ring color. */
  | { type: 'suspicion_updated'; scores: Record<AgentId, number> }
  /** A file on agentId's disk changed — UI may refetch GET .../disk. */
  | { type: 'disk_updated'; agentId: AgentId; path: string }
  /** Voting result. Followed by agent_moved {to:{kind:'void'}} for the same agent. Ties -> random pick among tied. */
  | { type: 'agent_eliminated'; round: number; agentId: AgentId; role: Role; tally: Tally }
  | { type: 'game_over'; winner: Winner; reason: string; roles: Record<AgentId, Role> }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string };

export interface EventMeta {
  /** Monotonic per game, starting at 1. */
  seq: number;
  ts: number;
  gameId: string;
}

export type GameEvent = EventMeta & GameEventPayload;
export type GameEventType = GameEventPayload['type'];
export type EventOf<T extends GameEventType> = Extract<GameEvent, { type: T }>;

export const GOD_ONLY_EVENTS: readonly GameEventType[] = ['roles_assigned', 'agent_thought', 'answer_key'];

/* ------------------------------------------------------------------ */
/* HTTP + SSE API (apps/server, default http://localhost:4000)         */
/* ------------------------------------------------------------------ */

/**
 * GET  /api/health
 *        -> HealthResponse
 * POST /api/games                         body: CreateGameRequest
 *        -> CreateGameResponse            (stops any running game first)
 * GET  /api/games/current
 *        -> CurrentGameResponse
 * GET  /api/games/:gameId                 (:gameId may be "current")
 *        -> GameSnapshot
 * GET  /api/games/:gameId/events?since=<seq>   (:gameId may be "current")
 *        -> text/event-stream. Replays all events with seq > since (default 0), then live.
 *           Each event:  "id: <seq>\ndata: <JSON GameEvent>\n\n"   (no `event:` line; use onmessage)
 *           Heartbeat every 15 s:  ": ping\n\n"
 *           When a NEW game is created, the stream for "current" sends that game's events from seq 1;
 *           clients must reset their store when they see game_created.
 * GET  /api/games/:gameId/agents/:agentId/disk     (agentId may be REFEREE_ID)
 *        -> DiskSnapshot
 *
 * CORS: allow all origins (web runs on :3000).
 * Env AUTO_START=1: server creates a game with AGENT_COUNT agents on boot, and a new one
 *   20 s after each game_over, so `pnpm demo` needs no manual input.
 */
export const API_ROUTES = {
  health: '/api/health',
  games: '/api/games',
  current: '/api/games/current',
  snapshot: (gameId: string) => `/api/games/${gameId}`,
  events: (gameId: string, since = 0) => `/api/games/${gameId}/events?since=${since}`,
  disk: (gameId: string, agentId: AgentId) => `/api/games/${gameId}/agents/${agentId}/disk`,
  /** GET -> HallOfFameStats (cross-game; SQLite on the persistent Archil disk, in-memory in mock mode). */
  stats: '/api/stats',
} as const;

export const DEFAULT_SERVER_PORT = 4000;
export const DEFAULT_WEB_PORT = 3000;

export interface HealthResponse {
  ok: true;
  mode: ModeInfo;
  gameId: string | null;
}

export type CreateGameRequest = Partial<Omit<GameConfig, 'models'>> & { models?: Partial<ModelConfig> };

export interface CreateGameResponse {
  gameId: string;
}

export interface CurrentGameResponse {
  gameId: string | null;
}

/** One finished game in the hall of fame. */
export interface HallOfFameGame {
  gameId: string;
  /** Epoch ms. */
  endedAt: number;
  winner: Winner;
  rounds: number;
  agentCount: number;
  impostorCount: number;
}

/** GET /api/stats. Agents are matched across games by display name. */
export interface HallOfFameStats {
  /** 'archil' = SQLite on the persistent Archil disk; 'memory' = this server process only. */
  backend: 'archil' | 'memory';
  totalGames: number;
  crewWins: number;
  /** crewWins / totalGames, null before the first game. */
  crewWinRate: number | null;
  /** Highest correct-vote ratio (votes on impostors / votes cast) as crew, min 2 crew games. */
  bestDetective: { name: string; games: number; correctVotes: number; votesCast: number; ratio: number } | null;
  /** Survived the most games as impostor (tiebreak: fewest votes against). */
  mostConvincingImpostor: { name: string; impostorGames: number; survived: number; timesVotedAgainst: number } | null;
  /** Newest first, at most 10. */
  lastGames: HallOfFameGame[];
}

/* ------------------------------------------------------------------ */
/* Engine <-> Agents boundary (apps/server/src/game <-> src/agents)    */
/* ------------------------------------------------------------------ */

/** What a player agent sees when it acts. Built by the engine; only what this agent may know. */
export interface AgentContext {
  gameId: string;
  round: number;
  totalRounds: number;
  topic: string;
  phase: Phase;
  self: AgentPublic;
  role: Role;
  /** Impostors know each other; empty for crew. */
  fellowImpostors: AgentId[];
  /** All alive agents (including self). */
  alive: AgentPublic[];
  /** All questions so far, oldest first. */
  questions: RefereeQuestion[];
  /** All revealed answers so far (all rounds), oldest first. */
  answers: Answer[];
  /** All votes from previous rounds. */
  pastVotes: Vote[];
  /** Past eliminations with revealed roles. */
  eliminated: { agentId: AgentId; role: Role; round: number }[];
}

export interface AnswerContext extends AgentContext {
  phase: 'answering';
  question: RefereeQuestion;
  /**
   * Impostors only, sometimes (GameConfig.impostorWhisperChance): a vague hint derived by the
   * ENGINE from one random crew answer to THIS question (crew answers are collected first, then
   * impostors are called). Never contains a URL; `text` never names the crewmate. `fromAgentId`
   * is for setting AnswerDraft.copiedFrom (god-only bookkeeping) and must not be shown to the model.
   * Answers are sealed: nobody sees other answers to this question before the reveal.
   */
  whisper?: { text: string; fromAgentId: AgentId };
  maxChars: number;
}

export interface VoteContext extends AgentContext {
  phase: 'voting';
  /** Valid targets: alive agents minus self. */
  candidates: AgentId[];
  /** Votes already cast this round (live, visible to later voters). */
  votesSoFar: Vote[];
  // Crew may spend leftover search budget (tracked by the agent layer) to verify claims/sources.
  /** This round's copy flags from the referee's Archil grep (evidence). */
  copySuspicions: CopySuspicion[];
}

export interface AnswerDraft {
  text: string;
  sourceUrl?: string;
  /** Impostor built this answer from a whisper derived from this agent's answer. */
  copiedFrom?: AgentId;
}

export interface VoteDecision {
  targetId: AgentId;
  reason: string;
  /** Updated suspicion 0..1 for agents self has an opinion on (also persisted to suspects.json). */
  suspicion: Record<AgentId, number>;
}

/** Side-channel the engine gives agents for events the agent layer originates. */
export interface AgentHooks {
  /** Allowed: search_performed, search_denied, agent_thought, disk_updated, agent_ready, log. */
  emit(event: GameEventPayload): void;
}

/** One live player agent (LLM brain + disk + sandbox). Implemented in apps/server/src/agents. */
export interface AgentRuntime {
  readonly id: AgentId;
  readonly role: Role;
  /** false for impostors — the web_search tool is ABSENT from their tool list, not just forbidden. */
  readonly hasWebSearch: boolean;
  /** Answer the referee's question; append to answers.md. */
  answer(ctx: AnswerContext): Promise<AnswerDraft>;
  /** Must return a targetId from ctx.candidates (engine falls back to random if invalid). Updates suspects.json. */
  vote(ctx: VoteContext): Promise<VoteDecision>;
  readDisk(): Promise<DiskSnapshot>;
  dispose(): Promise<void>;
  /** Optional: append the referee's fact-check of this agent's answer to sources/r<N>.md. Never throws. */
  recordSourceCheck?(question: RefereeQuestion, answer: Answer, check: SourceCheck): Promise<void>;
}

/** What the referee needs to fact-check one answer's cited source. */
export interface VerifyContext {
  gameId: string;
  round: number;
  topic: string;
  question: RefereeQuestion;
  answer: Answer;
}

export interface RefereeContext {
  gameId: string;
  round: number;
  totalRounds: number;
  topic: string;
  /** 0-based index within the round. */
  index: number;
  previousQuestions: RefereeQuestion[];
}

export interface RefereeQuestionDraft {
  /** One question with a short, checkable answer about the topic (recent news). */
  text: string;
  answerKey: string;
  sources: string[];
}

/** The referee (has web_search, own disk). Implemented in apps/server/src/agents. */
export interface RefereeRuntime {
  readonly id: typeof REFEREE_ID;
  askQuestion(ctx: RefereeContext): Promise<RefereeQuestionDraft>;
  /**
   * Optional: fetch answer.sourceUrl (Keenable Fetch) and judge the claim. The engine calls it in parallel
   * for every answer with a URL, with a short timeout; any failure becomes verdict 'unknown'.
   */
  verifyAnswer?(ctx: VerifyContext): Promise<SourceCheck>;
  readDisk(): Promise<DiskSnapshot>;
  dispose(): Promise<void>;
}

export interface AgentFactoryInput {
  gameId: string;
  config: GameConfig;
  agents: AgentPublic[];
  secrets: AgentSecret[];
  hooks: AgentHooks;
}

/**
 * Shared per-game "council" disk (Archil: susagent-<gameId>-council, mounted conditional at /mnt/council
 * in every sandbox; memory in mock). Each agent's answers go to r<N>/<agentId>.md.
 */
export interface CouncilRuntime {
  readonly backend: 'archil' | 'memory';
  readonly diskId?: string;
  /** Writes/updates r<round>/<agentId>.md with this answer (appends for multi-question rounds). */
  writeAnswer(answer: Answer): Promise<void>;
  /** Scans r<round>/ for distinctive phrases shared by exactly two agents. `answers` = this round, reveal order. */
  detectCopies(round: number, answers: Answer[], questionText: string): Promise<CopySuspicion[]>;
  /** Called AFTER every sandbox is stopped/deleted (they mount this disk). Throws on failure. */
  dispose(): Promise<void>;
}

/** Provisions referee + all N agents IN PARALLEL. Engine uses a fake factory in tests. */
export interface AgentFactory {
  readonly mode: ModeInfo;
  /**
   * Also loads cross-game LESSONS (see LESSONS_DISK_NAME) for each role and injects them into
   * that role's system prompt + copies them into each agent's notes.md.
   */
  createAll(
    input: AgentFactoryInput,
  ): Promise<{ referee: RefereeRuntime; agents: AgentRuntime[]; council?: CouncilRuntime }>;
  /**
   * Optional cross-game learning. Called by the engine ONCE after game_over (not for stopped
   * games), BEFORE runtimes are disposed. Appends 3-5 short dated lessons per role (one summary per
   * role, not per agent, to bound LLM cost), keeps the last ~30 per role, updates stats.json.
   * Must never throw (engine also wraps it with a timeout).
   */
  recordGameOver?(snapshot: GameSnapshot): Promise<void>;
}

/**
 * Persistent Archil disk shared across games (NOT tied to a gameId, never deleted by game cleanup).
 * Layout: crew/lessons.md, impostor/lessons.md, referee/lessons.md, stats.json
 * (stats.json = { games, crewWins, impostorWins, avgRounds, updatedAt }). Mock: local/in-memory.
 */
export const LESSONS_DISK_NAME = 'susagent-lessons';

/* ------------------------------------------------------------------ */
/* Web viewer store (apps/web/src/store.ts implements this)            */
/* ------------------------------------------------------------------ */

export interface SpeechBubble {
  id: string; // answer/message/question id
  text: string; // full text; the 3D layer truncates to ~60 chars
  /** performance.now() when received by the client. Show for ~3000 ms. */
  at: number;
}

export interface EliminationFx {
  role: Role;
  /** performance.now() when received. 3D plays launch+fall, then the role reveal. */
  at: number;
}

export interface LiveVote {
  voterId: AgentId;
  targetId: AgentId;
  reason: string;
  /** performance.now() when received (3D beam grow-in). */
  at: number;
}

export interface ViewerState {
  /** Reduced from events; null before game_created arrives. */
  game: GameSnapshot | null;
  source: 'live' | 'replay';
  connection: 'idle' | 'connecting' | 'live' | 'replaying' | 'ended' | 'error';
  godMode: boolean;
  selectedAgentId: AgentId | null;
  /** Latest speech per speaker (keys include REFEREE_ID). Set on question_asked, answer_submitted, message_posted. */
  speech: Record<AgentId, SpeechBubble>;
  /** Current round's votes keyed by voterId; cleared on round_started. Drives beams + live table. */
  liveVotes: Record<AgentId, LiveVote>;
  /** Current round's running tally (from the latest vote_cast). */
  liveTally: Tally;
  /** Set on agent_eliminated. */
  eliminations: Record<AgentId, EliminationFx>;
  /** God-only thoughts, newest last, capped at 200. */
  thoughts: EventOf<'agent_thought'>[];
  /** Replay speed multiplier (1 = real time). */
  replaySpeed: number;

  // actions
  setGodMode(on: boolean): void;
  selectAgent(id: AgentId | null): void;
  setSource(source: 'live' | 'replay'): void;
  setReplaySpeed(x: number): void;
  /** Pure reducer step; used by both the SSE hook and the replay player. */
  applyEvent(e: GameEvent): void;
  reset(): void;
}

/* ------------------------------------------------------------------ */
/* Replay fixture (packages/shared/fixtures/replay.json)               */
/* ------------------------------------------------------------------ */

export interface ReplayFixture {
  /** Ordered events; ts = ms offset from start. */
  events: GameEvent[];
  /** Disk contents at game end (keys include REFEREE_ID), for the selected-agent panel in replay. */
  disks: Record<AgentId, DiskSnapshot>;
}
