# SusAgent

A social-deduction game played **between AI agents**, watched live in a 3D arena.

A **referee** agent asks questions about recent news. Every player agent answers. Most players are
**crew**: they have a `web_search` tool and can look the answer up. A few are **impostors**: they have
**no search tool at all** (it is absent from their tool list, not just forbidden), so they must bluff a
plausible answer or quietly copy someone else's. After each answer round, everyone votes publicly on
who they think is faking it, and the most-voted agent is eliminated.

Every agent (and the referee) gets its **own Archil disk** where it keeps its answers, suspicions and
private notes: `answers.md`, `suspects.json`, `notes.md`, `sources/r<N>.md`.

## Rules (referee format)

- **Players:** N agents (default 12, min 6, max 50) plus the referee (not a player, cannot be voted).
- **Impostors:** `max(1, round(N / 6))`, so 1 for 6 agents, 2 for 12, 8 for 50. Impostors know each other.
- **Eliminations per round:** auto = `max(1, ceil(impostors * 1.5 / rounds))`, so 1 for 6-12 agents and 3 for 50 (override with `eliminationsPerRound`). At least one agent always survives.
- **5 rounds**, each one:
  1. **Question:** the referee asks one question about this round's topic (with a hidden answer key).
  2. **Answering:** every alive agent answers. Crew may `web_search` (budget 3 per round). Impostors
     can't search; they answer after about half the crew answers are visible, so they can blend in.
  3. **Voting:** every alive agent votes live; votes stream in one by one (beams in the 3D view).
  4. **Reveal:** the most-voted agent(s) are eliminated and their roles revealed. Ties are broken randomly among the tied agents.
- **Win conditions:**
  - **Crew wins** when every impostor has been eliminated.
  - **Impostors win** at parity (alive impostors >= alive crew), or if any impostor survives the last round.

## Quick start

```bash
pnpm install
pnpm demo
```

Then open **http://localhost:3000**. `pnpm demo` starts the API server on :4000 with `AUTO_START=1`
(a game starts on boot, and a new one 20 s after each game ends) and the Next.js viewer on :3000,
prefixes their logs, and stops both on Ctrl+C. If port 3000 is taken, the viewer moves to the next
free port (3001, 3002, ...); the demo prints the real URL (`SusAgent is up -> http://localhost:<port>`).
Port 4000 must be free, or pick another one with `PORT` (the demo points the viewer at it automatically, e.g. `$env:PORT=4100; pnpm demo` in PowerShell).

### Mock mode (no keys needed)

Every external service is optional. With no `.env`, or with `SUSAGENT_MOCK=1`, SusAgent runs fully
offline: scripted heuristic brains instead of OpenAI models, in-memory disks instead of Archil, canned search
results instead of a search API. The viewer shows the active mode as a badge (`llm / disks / search`, e.g. `llm: mock` here, `llm: openai` with a key).

## Configuration

Copy `.env.example` to `.env` at the repo root. Every key is optional, and a missing key falls back to mock.

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | OpenAI brains for agents and the referee (crew: `gpt-5-nano`, impostors and referee: `gpt-5-mini`). The mode badge shows `llm: openai`. Missing: scripted brains. |
| `ARCHIL_API_KEY`, `ARCHIL_REGION` | One Archil disk (and sandbox) per agent. Missing: local in-memory disks. |
| `KEENABLE_API_KEY` | Preferred web search for crew and referee. Without it, Keenable's public endpoint is still tried before falling back. |
| `LINKUP_API_KEY` / `EXA_API_KEY` / `TAVILY_API_KEY` | Fallback search providers. Cascade: Keenable > Linkup > Exa > Tavily > canned mock results. |
| `SUSAGENT_MOCK` | `1` forces mock mode for everything even if keys are present. |
| `PORT` | Server port (default 4000). `pnpm demo` also passes it to the viewer as `NEXT_PUBLIC_SERVER_URL` unless you set that yourself. |
| `WEB_PORT` | First port `pnpm demo` tries for the viewer (default 3000; scans upward if busy). |
| `AUTO_START` | `1` makes the server start a game on boot and again after each game_over. |
| `AGENT_COUNT` | Number of agents in auto-started games (default 12, max 50). |
| `NEXT_PUBLIC_SERVER_URL` | Where the viewer finds the server (default `http://localhost:4000`). |

### How impostors are cut off from search

Impostors never get a `web_search` tool: it is absent from their tool list. With an Archil
**Developer plan**, each impostor's sandbox also gets a per-role network firewall, so it can't reach
`api.keenable.ai` or any other search API: the allowlist only lets through `api.openai.com` for the model calls. The **Free plan** has no firewall, so the server relies on
removing the tool server-side. `mode.impostorEgressBlocked` (in the viewer and `GET /api/health`)
shows which one applies.

### Running with 50 agents

Either set `AGENT_COUNT=50` in `.env`, or set it inline for one run:

```bash
AGENT_COUNT=50 pnpm demo              # macOS / Linux / Git Bash
```

```powershell
$env:AGENT_COUNT=50; pnpm demo        # Windows PowerShell
```

You can also type 50 in the
**New Game** input in the viewer, which calls `POST /api/games` with `{ "agentCount": 50 }`. All 50 disks
are provisioned in parallel; agents are laid out on islands of 6.

## Viewer

- **Live mode:** follows the current game over SSE (`/api/games/current/events`).
- **God mode:** toggle to reveal hidden info: every agent's role, the referee's answer key, which
  answers were fabricated or copied, and agents' private reasoning (`agent_thought`). Off by default,
  so you can play along and guess the impostors yourself.
- **Replay mode:** plays back a recorded game from `packages/shared/fixtures/replay.json` with a speed
  control. It works without a server.
- Click an agent to see its disk (answers, suspects, notes, sources).

## Architecture

```
packages/shared/      @susagent/shared - contracts.ts (THE source of truth: types, events, API), replay fixture
apps/server/          @susagent/server - Fastify on :4000
  src/game/           engine: roles, rounds, voting, win checks, event stream (pure helpers + runGame)
  src/agents/         agent runtimes: OpenAI brains, tools (web_search for crew/referee only), Archil disks, search
apps/web/             @susagent/web    - Next.js on :3000, react-three-fiber 3D arena + zustand store + UI panels
tests/                vitest suites (engine rules, impostor tooling, fixture)
scripts/              demo.mjs (run everything), e2e.ts (headless full game)
```

Everything flows through **events** defined in `packages/shared/contracts.ts`. The engine emits
`GameEvent`s (monotonic `seq` from 1, first event `game_created`, last `game_over`). The server
streams them over SSE (`GET /api/games/:id/events?since=<seq>`), and the web store reduces them with
the same `applyEvent` for live and replay. God-only events (`roles_assigned`, `answer_key`,
`agent_thought`) are streamed to everyone and hidden by the UI unless god mode is on.

HTTP API (default `http://localhost:4000`):
`GET /api/health`, `POST /api/games`, `GET /api/games/current`, `GET /api/games/:id`,
`GET /api/games/:id/events`, `GET /api/games/:id/agents/:agentId/disk`.

## Testing

```bash
pnpm test         # vitest: engine rules, impostor has no web_search, replay fixture checks
pnpm test:balance # 20 mock 12-agent games, prints the crew win rate (informational)
pnpm e2e          # headless 6-agent game in mock mode; prints a round log, fails if no game_over in 2 min
pnpm typecheck    # tsc across all workspaces
```
