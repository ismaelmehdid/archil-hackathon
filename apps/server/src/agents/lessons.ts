/**
 * Cross-game self-improvement: a persistent "susagent-lessons" store (Archil disk, or a local folder in mock
 * mode: in-memory, or .susagent-disks/ when LESSONS_STORE=file) holding per-role lessons + stats. Loaded at createAll, appended once per completed game.
 *
 * Layout: crew/lessons.md, impostor/lessons.md, referee/lessons.md, stats.json
 * The disk is NOT tied to a gameId and is never deleted by per-game cleanup (which only deletes the
 * ArchilDisk objects it created, named `susagent-<gameId>-<agentId>`).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as archil from 'disk';
import OpenAI from 'openai';
import { LESSONS_DISK_NAME, type GameSnapshot, type ModeInfo } from '@susagent/shared';
import { withTimeout } from './archil';
import { jaccard, tokens } from './mockData';

export type LessonRole = 'crew' | 'impostor' | 'referee';
const ROLES: LessonRole[] = ['crew', 'impostor', 'referee'];
const MAX_LESSONS = 30;
/** How many of the newest lessons are injected into prompts (keeps prompts small). */
export const PROMPT_LESSONS = 8;

export interface LessonStats {
  games: number;
  crewWins: number;
  impostorWins: number;
  avgRounds: number;
  updatedAt: number;
}

interface Store {
  backend: 'archil' | 'file' | 'memory';
  diskId?: string;
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Stores                                                              */
/* ------------------------------------------------------------------ */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const LOCAL_DIR = join(repoRoot, '.susagent-disks', LESSONS_DISK_NAME);

function fileStore(): Store {
  return {
    backend: 'file',
    async read(path) {
      try {
        return await readFile(join(LOCAL_DIR, path), 'utf8');
      } catch {
        return null;
      }
    },
    async write(path, content) {
      const full = join(LOCAL_DIR, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content, 'utf8');
    },
  };
}


/** In-process store (mock/tests): no state leaks between test runs, but consecutive games in one process still learn. */
const memoryFiles = new Map<string, string>();
function memoryStore(): Store {
  return {
    backend: 'memory',
    async read(path) {
      return memoryFiles.get(path) ?? null;
    },
    async write(path, content) {
      memoryFiles.set(path, content);
    },
  };
}
async function archilStore(): Promise<Store> {
  const found = (await withTimeout(archil.listDisks({ name: LESSONS_DISK_NAME }), 10_000, 'listDisks')).find(
    (d) => d.name === LESSONS_DISK_NAME,
  );
  const disk = found ?? (await withTimeout(archil.createDisk({ name: LESSONS_DISK_NAME }), 20_000, 'createDisk lessons')).disk;
  return {
    backend: 'archil',
    diskId: disk.id,
    async read(path) {
      try {
        return new TextDecoder().decode(await withTimeout(disk.getObject(path), 10_000, `getObject ${path}`));
      } catch {
        return null; // NoSuchKey on first use
      }
    },
    async write(path, content) {
      await withTimeout(disk.putObject(path, content), 10_000, `putObject ${path}`);
    },
  };
}

const stores = new Map<string, Promise<Store>>();
/** One store per backend per process. Archil failures fall back to the local file store. */
function getStore(mode: ModeInfo): Promise<Store> {
  const key = mode.disks;
  if (!stores.has(key)) {
    stores.set(
      key,
      mode.disks === 'archil'
        ? archilStore().catch((err) => {
            console.warn(`[lessons] Archil lessons disk unavailable (${(err as Error).message.slice(0, 120)}); using local file store`);
            stores.delete(key);
            return fileStore();
          })
        : Promise.resolve(process.env.LESSONS_STORE === 'file' ? fileStore() : memoryStore()),
    );
  }
  return stores.get(key)!;
}

/* ------------------------------------------------------------------ */
/* Load                                                                */
/* ------------------------------------------------------------------ */

export interface LoadedLessons {
  byRole: Record<LessonRole, string[]>;
  stats: LessonStats | null;
  backend: Store['backend'];
  diskId?: string;
}

const parseLessons = (md: string | null) => (md ?? '').split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim());

export async function loadLessons(mode: ModeInfo): Promise<LoadedLessons> {
  const empty: LoadedLessons = { byRole: { crew: [], impostor: [], referee: [] }, stats: null, backend: 'memory' };
  try {
    return await withTimeout(
      (async () => {
        const store = await getStore(mode);
        const [crew, impostor, referee, stats] = await Promise.all([
          ...ROLES.map((r) => store.read(`${r}/lessons.md`)),
          store.read('stats.json'),
        ]);
        let parsed: LessonStats | null = null;
        try {
          parsed = stats ? (JSON.parse(stats) as LessonStats) : null;
        } catch {
          parsed = null;
        }
        return {
          byRole: { crew: parseLessons(crew), impostor: parseLessons(impostor), referee: parseLessons(referee) },
          stats: parsed,
          backend: store.backend,
          diskId: store.diskId,
        };
      })(),
      20_000,
      'loadLessons',
    );
  } catch (err) {
    console.warn(`[lessons] load failed: ${(err as Error).message.slice(0, 160)}`);
    return empty;
  }
}

export function lessonsSummaryLine(l: LoadedLessons): string {
  const s = l.stats;
  const rate = s && s.games ? Math.round((100 * s.crewWins) / s.games) : 0;
  return `[lessons] loaded ${l.byRole.crew.length} crew / ${l.byRole.impostor.length} impostor / ${l.byRole.referee.length} referee lessons; stats: ${s?.games ?? 0} games, crew win rate ${rate}%, avg rounds ${s ? s.avgRounds.toFixed(1) : '0'} (${l.backend}${l.diskId ? ` ${l.diskId}` : ''})`;
}

/** Text block for a system prompt (newest last). Empty string when there are none. */
export function lessonsPrompt(lessons: string[]): string {
  const recent = lessons.slice(-PROMPT_LESSONS);
  return recent.length ? `\nLessons from previous games:\n${recent.map((l) => `- ${l}`).join('\n')}` : '';
}

/* ------------------------------------------------------------------ */
/* Record                                                              */
/* ------------------------------------------------------------------ */

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const dom = (u?: string) => {
  try {
    return u ? new URL(u).hostname.replace(/^www\./, '') : 'no source';
  } catch {
    return 'bad url';
  }
};

/** Compact, role-tagged digest of a finished game for the summarizer. */
export function digest(s: GameSnapshot): string {
  const name = (id: string) => s.agents.find((a) => a.id === id)?.name ?? id;
  const lines: string[] = [`Winner: ${s.winner} (${s.winReason}). Rounds: ${s.round}.`];
  for (const q of s.questions) {
    const key = s.answerKeys.find((k) => k.questionId === q.id);
    lines.push(`R${q.round} topic "${q.topic}" Q: ${q.text} | KEY: ${key?.answer ?? '?'}`);
    const qs = s.searches.filter((x) => x.round === q.round && x.agentId === 'referee').map((x) => x.query);
    if (qs.length) lines.push(`  referee searched: ${qs.map((x) => `"${clip(x, 70)}"`).join(', ')}`);
    for (const a of s.answers.filter((x) => x.questionId === q.id)) {
      const tag = s.roles[a.agentId] === 'impostor' ? `IMPOSTOR${a.copiedFrom ? ` (rumor from ${a.copiedFrom})` : ' (blind)'}` : 'crew';
      lines.push(`  ${a.agentId} ${name(a.agentId)} [${tag}]: ${clip(a.text, 110)} <${dom(a.sourceUrl)}>`);
    }
    const votes = s.votes.filter((v) => v.round === q.round);
    if (votes.length) lines.push(`  votes: ${votes.map((v) => `${v.voterId}->${v.targetId}`).join(' ')}`);
    const out = s.eliminated.filter((e) => e.round === q.round);
    if (out.length) lines.push(`  eliminated: ${out.map((e) => `${e.agentId} (${e.role})`).join(', ')}`);
  }
  return clip(lines.join('\n'), 9000);
}

const ROLE_ASK: Record<LessonRole, string> = {
  crew: 'You coach the CREW (they have web search). Write lessons about: which searches/sources found the answer key, which tells exposed impostors, which wrongful votes happened and why.',
  impostor: 'You coach the IMPOSTORS (no web search, must bluff). Write lessons about: which bluffs held and which got caught, and why.',
  referee: 'You coach the REFEREE (writes one checkable recent-news question per round). Write lessons about: questions that were too easy (everyone right) or too hard (crew wrong), and which search queries produced clean, short answer keys.',
};

let client: OpenAI | null = null;
async function llmLessons(role: LessonRole, game: string, model: string): Promise<string[]> {
  client ??= new OpenAI({ maxRetries: 0, timeout: 25_000 });
  const res = await client.chat.completions.create({
    model,
    max_completion_tokens: 1200,
    reasoning_effort: 'minimal',
    messages: [
      { role: 'system', content: `${ROLE_ASK[role]} Output 3 to 5 lessons, one per line, each under 160 characters, concrete and actionable, no numbering, no preamble.` },
      { role: 'user', content: game },
    ],
  });
  return (res.choices[0]?.message.content ?? '')
    .split('\n')
    .map((l) => l.replace(/^\s*([-*•]|\d+[.)])\s*/, '').trim())
    .filter((l) => l.length > 8)
    .slice(0, 5)
    .map((l) => clip(l, 200));
}

/** Simple lessons derived from the snapshot (mock mode / LLM failure), so the loop works without keys. */
export function heuristicLessons(role: LessonRole, s: GameSnapshot): string[] {
  const out: string[] = [];
  const keyOf = (qid: string) => s.answerKeys.find((k) => k.questionId === qid)?.answer ?? '';
  const right = (text: string, key: string) => {
    const kt = tokens(key);
    const t = new Set(tokens(text));
    return kt.length > 0 && kt.filter((x) => t.has(x)).length / kt.length >= 0.6;
  };
  const crewAns = s.answers.filter((a) => s.roles[a.agentId] === 'crew');
  const impAns = s.answers.filter((a) => s.roles[a.agentId] === 'impostor');
  if (role === 'crew') {
    const good = new Map<string, number>();
    for (const a of crewAns) if (right(a.text, keyOf(a.questionId))) good.set(dom(a.sourceUrl), (good.get(dom(a.sourceUrl)) ?? 0) + 1);
    const best = [...good.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best) out.push(`Correct answers most often cited ${best[0]} (${best[1]}x); search the question text directly and cite your own result.`);
    const wrong = s.eliminated.filter((e) => e.role === 'crew');
    if (wrong.length) {
      const w = wrong[0]!;
      const a = s.answers.find((x) => x.agentId === w.agentId && x.round === w.round);
      out.push(`Wrongful vote: crewmate ${w.agentId} was eliminated in round ${w.round}${a ? ` for "${clip(a.text, 60)}"` : ''}; one off answer is not proof, check the source first.`);
    }
    const caught = s.eliminated.filter((e) => e.role === 'impostor');
    if (caught.length) out.push(`Impostors caught: ${caught.length}. Fabricated sources that never show up in search results were the strongest tell.`);
    out.push(`Result: ${s.winner} won after ${s.round} rounds; ${s.winner === 'crew' ? 'keep verifying sources' : 'converge votes on the leading suspect earlier'}.`);
  } else if (role === 'impostor') {
    for (const a of impAns.slice(0, 4)) {
      const caught = s.eliminated.some((e) => e.agentId === a.agentId && e.round === a.round);
      const kind = a.copiedFrom ? 'rumor-based' : 'blind';
      const near = crewAns.filter((c) => c.questionId === a.questionId).some((c) => jaccard(c.text, a.text) > 0.3);
      out.push(`R${a.round} ${kind} bluff "${clip(a.text, 50)}" ${caught ? 'got caught' : 'held'}${near ? ' (it matched the crew majority)' : ' (it stood out from the majority)'}.`);
    }
    if (!out.length) out.push('No impostor answers recorded; answer confidently with a specific claim and a realistic source.');
  } else {
    for (const q of s.questions.slice(0, 4)) {
      const key = keyOf(q.id);
      const qa = crewAns.filter((a) => a.questionId === q.id);
      const pct = qa.length ? Math.round((100 * qa.filter((a) => right(a.text, key)).length) / qa.length) : 0;
      const verdict = pct >= 90 ? 'too easy' : pct <= 30 ? 'too hard or ambiguous' : 'well balanced';
      out.push(`"${clip(q.text, 60)}" (key "${clip(key, 30)}"): ${pct}% of crew right, ${verdict}.`);
    }
  }
  return out.slice(0, 5);
}

function updateStats(prev: LessonStats | null, s: GameSnapshot): LessonStats {
  const p = prev ?? { games: 0, crewWins: 0, impostorWins: 0, avgRounds: 0, updatedAt: 0 };
  const games = p.games + 1;
  return {
    games,
    crewWins: p.crewWins + (s.winner === 'crew' ? 1 : 0),
    impostorWins: p.impostorWins + (s.winner === 'impostor' ? 1 : 0),
    avgRounds: Math.round(((p.avgRounds * p.games + s.round) / games) * 100) / 100,
    updatedAt: Date.now(),
  };
}

/** Appends 3-5 dated lessons per role and updates stats.json. Never throws; capped at 30 s. */
export async function recordGameOver(mode: ModeInfo, snapshot: GameSnapshot, log: (msg: string) => void = console.log): Promise<void> {
  if (snapshot.status !== 'over' || !snapshot.winner) return;
  const run = async () => {
    const store = await getStore(mode);
    const date = new Date().toISOString().slice(0, 10);
    const game = digest(snapshot);
    const useLlm = mode.llm === 'openai';
    const counts: string[] = [];
    await Promise.all(
      ROLES.map(async (role) => {
        let lessons: string[] = [];
        if (useLlm) {
          try {
            lessons = await llmLessons(role, game, snapshot.config.models.referee);
          } catch (err) {
            log(`[lessons] ${role} LLM summary failed (${(err as Error).message.slice(0, 100)}); using heuristic lessons`);
          }
        }
        if (lessons.length < 3) lessons = [...lessons, ...heuristicLessons(role, snapshot)].slice(0, 5);
        const path = `${role}/lessons.md`;
        const existing = parseLessons(await store.read(path));
        const all = [...existing, ...lessons.map((l) => `${date} ${snapshot.gameId}: ${l}`)].slice(-MAX_LESSONS);
        await store.write(path, `# ${role} lessons (newest last)\n\n${all.map((l) => `- ${l}`).join('\n')}\n`);
        counts.push(`${lessons.length} ${role}`);
      }),
    );
    let prev: LessonStats | null = null;
    try {
      const raw = await store.read('stats.json');
      prev = raw ? (JSON.parse(raw) as LessonStats) : null;
    } catch {
      prev = null;
    }
    const stats = updateStats(prev, snapshot);
    await store.write('stats.json', JSON.stringify(stats, null, 2));
    log(`[lessons] ${snapshot.gameId}: wrote ${counts.join(' / ')} lessons (${useLlm ? 'llm' : 'heuristic'}, ${store.backend}); stats: ${stats.games} games, crew win rate ${Math.round((100 * stats.crewWins) / stats.games)}%`);
  };
  try {
    await withTimeout(run(), 30_000, 'recordGameOver');
  } catch (err) {
    log(`[lessons] recordGameOver failed: ${(err as Error).message.slice(0, 160)}`);
  }
}
