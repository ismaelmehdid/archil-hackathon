import type { Answer, RefereeQuestion, SourceCheck, SourceVerdict } from '@susagent/shared';
import { HttpError, keenableFetch } from './search';
import { core } from './heuristic';
import { genericQuestions, jaccard, matchBank, QUESTION_BANK } from './mockData';

const QUOTE_CHARS = 160;
/** Per-check budget inside the agents layer (the engine also guards each call). */
export const FACTCHECK_TIMEOUT_MS = 12_000;

export function factCheckPrompt(answer: string, question: string): string {
  const clean = (s: string) => s.replace(/\s+/g, ' ').replace(/'/g, '’').trim();
  return `Does this page support the claim '${clean(answer).slice(0, 400)}' for the question '${clean(question).slice(0, 400)}'? Reply SUPPORTED, CONTRADICTED or NOT_FOUND, then one short quote.`;
}

const clipQuote = (s: string) => {
  const q = s
    .replace(/\s+/g, ' ')
    .replace(/^[\s:.\-–—,;"“”'‘’*]+|[\s"“”'‘’*]+$/g, '')
    .trim();
  return q.length > QUOTE_CHARS ? q.slice(0, QUOTE_CHARS - 1) + '…' : q;
};

/**
 * Maps the reader model's reply to a verdict. Takes the EARLIEST verdict keyword (so "SUPPORTED — the
 * page doesn't contradict it" stays supported). Anything without a keyword is 'unknown'.
 */
export function parseVerdict(content: string): { verdict: SourceVerdict; quote?: string } {
  const text = String(content ?? '');
  const re = /\b(NOT[\s_-]?FOUND|CONTRADICTED|SUPPORTED|UNSUPPORTED)\b/i;
  const m = re.exec(text);
  if (!m) return { verdict: 'unknown', quote: clipQuote(text) || undefined };
  const word = m[1]!.toUpperCase().replace(/[\s-]/g, '_');
  const verdict: SourceVerdict =
    word === 'SUPPORTED' ? 'supported' : word === 'CONTRADICTED' || word === 'UNSUPPORTED' ? 'contradicted' : 'not_found';
  const quote = clipQuote(text.slice(m.index + m[0].length));
  return quote ? { verdict, quote } : { verdict };
}

/** HTTP status of a failed fetch -> verdict. 404 / 400 = there is no page at that URL. */
export function verdictForHttpStatus(status: number): SourceVerdict {
  return status === 404 || status === 400 || status === 410 ? 'not_found' : 'unknown';
}

/**
 * Mock mode: deterministic canned verdicts. URLs the canned search actually returns are "real pages":
 * SUPPORTED when the claim matches the page's answer, CONTRADICTED otherwise (a crew misread). Any other
 * URL (impostor-invented) is NOT_FOUND.
 */
export function mockVerify(question: RefereeQuestion, answer: Answer): SourceCheck {
  const url = answer.sourceUrl;
  if (!url) return { verdict: 'no_source' };
  const pages = new Map<string, { answer: string; snippet: string }>();
  const banks = [...QUESTION_BANK, ...genericQuestions(question.topic)];
  for (const bq of banks) for (const r of bq.results) pages.set(r.url, { answer: bq.answer, snippet: r.snippet });
  const page = pages.get(url);
  if (!page) {
    // The canned search's generic fallback page exists but can't confirm anything specific.
    if (url.startsWith('https://news.example.com/search')) return { verdict: 'unknown', url, quote: 'Generic coverage page; details vary between sources.' };
    return { verdict: 'not_found', url, quote: 'No page at this URL.' };
  }
  const bq = matchBank(question.text, question.topic);
  const truth = bq?.answer ?? page.answer;
  const claim = core(answer.text).toLowerCase();
  const ok = claim.includes(truth.toLowerCase()) || jaccard(claim, truth) >= 0.5;
  return ok ? { verdict: 'supported', url, quote: page.snippet } : { verdict: 'contradicted', url, quote: page.snippet };
}

/** Real check via Keenable Fetch with a prompt. Never throws: failures become 'unknown'. */
export async function fetchVerify(question: RefereeQuestion, answer: Answer, timeoutMs = FACTCHECK_TIMEOUT_MS): Promise<SourceCheck> {
  const url = answer.sourceUrl?.trim();
  if (!url) return { verdict: 'no_source' };
  let parsed: URL;
  try {
    parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('bad scheme');
  } catch {
    return { verdict: 'not_found', url, quote: 'Not a valid URL.' };
  }
  try {
    const page = await keenableFetch(parsed.toString(), {
      prompt: factCheckPrompt(answer.text, question.text),
      maxChars: 600,
      timeoutMs,
    });
    return { url, ...parseVerdict(page.content) };
  } catch (err) {
    if (err instanceof HttpError) {
      const verdict = verdictForHttpStatus(err.status);
      return { verdict, url, quote: verdict === 'not_found' ? `No page at this URL (HTTP ${err.status}).` : `Check failed (HTTP ${err.status}).` };
    }
    const msg = (err as Error)?.name === 'AbortError' ? 'timed out' : String((err as Error)?.message ?? err).slice(0, 80);
    return { verdict: 'unknown', url, quote: `Check failed (${msg}).` };
  }
}

/** Markdown block appended to the answering agent's sources/r<N>.md. */
export function sourceCheckMarkdown(question: RefereeQuestion, answer: Answer, check: SourceCheck): string {
  return (
    `### Referee fact-check (${question.id})\n` +
    `- Claim: ${answer.text}\n` +
    `- Source: ${check.url ?? answer.sourceUrl ?? '(none cited)'}\n` +
    `- Verdict: **${check.verdict.toUpperCase()}**\n` +
    (check.quote ? `- Quote: "${check.quote}"\n` : '') +
    '\n'
  );
}
