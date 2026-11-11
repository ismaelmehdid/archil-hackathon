import type { AgentId, Answer, CopySuspicion, CouncilRuntime } from '@susagent/shared';

/**
 * Shared council disk + copy detector.
 *
 * Layout: r<N>/<agentId>.md, one line per answer ("<text> [<url>]"), so ripgrep's line-based matching
 * sees each answer whole. Detection: for each answer B, take its distinctive n-grams (4-word, or 3-word
 * containing a number, not in the question), grep r<N>/ for them, and flag "B copied A" when a phrase
 * appears in exactly two agents' files and A revealed an answer containing it before B.
 */

export const councilPath = (round: number, agentId: AgentId) => `r${round}/${agentId}.md`;

export function councilLine(a: Answer): string {
  const text = a.text.replace(/\s+/g, ' ').trim();
  return `${text}${a.sourceUrl ? ` [${a.sourceUrl.replace(/\s+/g, '')}]` : ''}`;
}

const STOP = new Set(
  'a an the and or but of to in on at for by with from as is are was were be been it its this that these those i im it s per according reports report said says has have had not no yes my me we our you your they their he she his her them what which who whom when where why how than then so do does did about into over after before up out just also sure pretty think found same thing read saw point points com org net www https http'.split(
    ' ',
  ),
);

const tokenize = (s: string) => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
/** URLs and bare domains (reuters.com) are citations, not content: crew citing the same outlet isn't copying. */
const stripCitations = (s: string) => s.replace(/https?:\/\/\S+/g, ' ').replace(/\b[\w-]+(\.[\w-]+)*\.(com|org|net|io|ai|co|uk|eu|int|gov|edu|news|media|so)\b/gi, ' ');
const isContent = (t: string) => !STOP.has(t) && (t.length > 1 || /\d/.test(t));
/** Content tokens in order (stopwords, template words and citations removed). */
const contentTokens = (s: string) => tokenize(stripCitations(s)).filter(isContent);

/**
 * Distinctive phrases of an answer, most distinctive first (max `limit`): 3 consecutive CONTENT words
 * (stopwords between them are skipped), not all taken from the question.
 */
export function candidatePhrases(text: string, questionText: string, limit = 6): string[] {
  const toks = contentTokens(text);
  const q = new Set(contentTokens(questionText));
  const out = new Map<string, number>();
  for (let i = 0; i + 3 <= toks.length; i++) {
    const gram = toks.slice(i, i + 3);
    const novel = gram.filter((t) => !q.has(t));
    if (novel.length < 2) continue; // mostly echoing the question is not evidence of copying
    const hasNum = gram.some((t) => /\d/.test(t));
    const score = novel.reduce((n, t) => n + t.length, 0) + (hasNum ? 6 : 0);
    const phrase = gram.join(' ');
    out.set(phrase, Math.max(out.get(phrase) ?? 0, score));
  }
  return [...out.entries()]
    .sort((x, y) => y[1] - x[1])
    .slice(0, limit)
    .map(([ph]) => ph);
}

/**
 * Pattern that behaves identically in ripgrep and JS: explicit ASCII alphanumeric boundaries (ripgrep's
 * \b and \W are Unicode, JS's are ASCII), content words separated by non-alphanumerics plus up to two
 * filler words. Always used case-insensitively.
 */
export const phrasePattern = (phrase: string) =>
  `(?:^|[^a-z0-9])${phrase.split(' ').join('(?:[^a-z0-9]+[a-z0-9]+){0,2}[^a-z0-9]+')}(?:[^a-z0-9]|$)`;
const phraseRe = (phrase: string) => new RegExp(phrasePattern(phrase), 'i');

/** r<N>/<agentId>.md (path relative to disk root or to r<N>/) -> agentId. */
export const agentOfPath = (file: string): AgentId | null => {
  const m = /(?:^|\/)([^/]+)\.md$/.exec(file.replace(/\\/g, '/'));
  return m ? m[1]! : null;
};

/** Given grep hits (file + line text) for answer B's phrases, decide copy flags. Shared by both backends. */
export function judgeHits(
  round: number,
  answers: Answer[],
  b: Answer,
  phrases: string[],
  hits: { file: string; text: string }[],
  via: CopySuspicion['via'],
): CopySuspicion | null {
  const bIdx = answers.indexOf(b);
  const mine = contentSet(answers.filter((a) => a.agentId === b.agentId).map((a) => a.text).join(' '));
  for (const phrase of phrases) {
    const re = phraseRe(phrase);
    const agentsWith = new Set<AgentId>();
    for (const h of hits) {
      const id = agentOfPath(h.file);
      if (id && re.test(h.text)) agentsWith.add(id);
    }
    if (agentsWith.size !== 2 || !agentsWith.has(b.agentId)) continue;
    const other = [...agentsWith].find((x) => x !== b.agentId)!;
    const theirAnswers = answers.filter((a) => a.agentId === other);
    if (!theirAnswers.some((a) => re.test(a.text))) continue;
    // Direction: answers are sealed and revealed shuffled, so order says nothing. The copier is the one whose
    // content is mostly contained in the other's (a whispered gist is a subset). Tie -> later reveal.
    const theirs = contentSet(theirAnswers.map((a) => a.text).join(' '));
    const shared = [...mine].filter((t) => theirs.has(t)).length;
    const myRatio = shared / Math.max(1, mine.size);
    const theirRatio = shared / Math.max(1, theirs.size);
    const otherIdx = answers.indexOf(theirAnswers[theirAnswers.length - 1]!);
    const iCopied = myRatio > theirRatio + 1e-9 || (Math.abs(myRatio - theirRatio) <= 1e-9 && bIdx > otherIdx);
    if (iCopied) return { round, agentId: b.agentId, fromAgentId: other, phrase, via };
  }
  return null;
}

function contentSet(text: string): Set<string> {
  return new Set(contentTokens(text));
}

type GrepFn = (round: number, patterns: string[]) => Promise<{ file: string; text: string }[]>;

/** Runs the detector for one round with the given grep backend. One flag max per answering agent. */
export async function detectWith(
  grep: GrepFn,
  round: number,
  answers: Answer[],
  questionText: string,
  via: CopySuspicion['via'],
): Promise<CopySuspicion[]> {
  const flags: CopySuspicion[] = [];
  const flagged = new Set<AgentId>();
  const jobs = answers.map(async (b) => {
    const phrases = candidatePhrases(b.text, questionText);
    if (!phrases.length) return null;
    const hits = await grep(round, phrases.map(phrasePattern));
    return judgeHits(round, answers, b, phrases, hits, via);
  });
  for (const f of await Promise.all(jobs)) {
    if (f && !flagged.has(f.agentId)) {
      flagged.add(f.agentId);
      flags.push(f);
    }
  }
  return flags;
}

/** In-memory council (mock mode, tests, and Archil fallback): plain regex scan over the same layout. */
export class MemoryCouncil implements CouncilRuntime {
  readonly backend = 'memory' as const;
  readonly diskId?: string = undefined;
  readonly files = new Map<string, string>();

  async writeAnswer(a: Answer): Promise<void> {
    const p = councilPath(a.round, a.agentId);
    const prev = this.files.get(p);
    this.files.set(p, prev ? `${prev}\n${councilLine(a)}` : councilLine(a));
  }

  grepLocal: GrepFn = async (round, patterns) => {
    const res = patterns.map((p) => new RegExp(p, 'i'));
    const hits: { file: string; text: string }[] = [];
    for (const [file, content] of this.files) {
      if (!file.startsWith(`r${round}/`)) continue;
      for (const line of content.split('\n')) if (res.some((r) => r.test(line))) hits.push({ file, text: line });
    }
    return hits;
  };

  detectCopies(round: number, answers: Answer[], questionText: string): Promise<CopySuspicion[]> {
    return detectWith(this.grepLocal, round, answers, questionText, 'regex');
  }

  async dispose(): Promise<void> {
    /* nothing to release */
  }
}
