import type { ModeInfo, SearchResult } from '@susagent/shared';
import { matchBank, genericQuestions, tokens } from './mockData';

const TIMEOUT_MS = 8000;
const MAX_RESULTS = 4;
const SNIPPET_CHARS = 300;
const KEENABLE = 'https://api.keenable.ai/v1';

function forcedMock(): boolean {
  return process.env.SUSAGENT_MOCK === '1';
}

/* Circuit breaker so an unreachable keyless endpoint doesn't cost 8 s per search. */
let publicFailures = 0;
let publicDownUntil = 0;
const keenablePublicDown = () => Date.now() < publicDownUntil;
function notePublic(ok: boolean) {
  if (ok) publicFailures = 0;
  else if (++publicFailures >= 2) {
    publicDownUntil = Date.now() + 60_000;
    publicFailures = 0;
  }
}

/**
 * Which search backend is live: KEENABLE > LINKUP > EXA > TAVILY > mock.
 * With no key at all, Keenable's keyless public endpoint is used (canned results on error).
 */
export function searchProvider(): ModeInfo['search'] {
  if (forcedMock()) return 'mock';
  if (process.env.KEENABLE_API_KEY) return 'keenable';
  if (process.env.LINKUP_API_KEY) return 'linkup';
  if (process.env.EXA_API_KEY) return 'exa';
  if (process.env.TAVILY_API_KEY) return 'tavily';
  return keenablePublicDown() ? 'mock' : 'keenable';
}

export interface SearchOptions {
  /** Hint for canned results. */
  topic?: string;
  forceMock?: boolean;
  /** Keenable: 'realtime' for crew, 'pro' for the referee. */
  mode?: 'realtime' | 'pro';
  /** Keenable session grouping: `${gameId}-${agentId}`. */
  sessionId?: string;
  /** Keenable: freeze the web at this ISO time (game start) for fairness/replay. */
  queryTime?: string;
  /** Keenable: lower publish bound, e.g. '7d' for the referee. */
  publishedAfter?: string;
  /**
   * Optional transport performing the keyed Keenable call from INSIDE the agent's Archil sandbox
   * (the sandbox firewall injects X-API-Key). Returns parsed JSON. Falls back to direct fetch on error.
   */
  sandboxFetch?: (url: string, body: unknown) => Promise<any>;
}

export interface DetailedSearch {
  results: SearchResult[];
  mock: boolean;
}

/** Canned results: matches the query against the referee question bank, else a generic fallback. */
export function mockSearch(query: string, topic?: string): SearchResult[] {
  const bq = matchBank(query, topic) ?? (topic ? genericQuestions(topic)[0]! : null);
  if (bq) return bq.results;
  const words = tokens(query).slice(0, 4).join(' ') || 'news';
  return [
    {
      title: `Latest coverage: ${words}`,
      url: `https://news.example.com/search?q=${encodeURIComponent(words)}`,
      snippet: `Coverage of ${words} this week; several outlets report developments but details vary between sources.`,
    },
  ];
}

const clip = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, SNIPPET_CHARS);

export class HttpError extends Error {
  constructor(readonly status: number) {
    super(`search HTTP ${status}`);
  }
}

/** JSON request with one 429 retry (Retry-After, capped at 5 s so a game never stalls). Throws HttpError. */
async function requestJson(
  url: string,
  init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: unknown },
  timeoutMs = TIMEOUT_MS,
  retried = false,
): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method,
      headers: init.body === undefined ? init.headers : { 'content-type': 'application/json', ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: ctrl.signal,
    });
    if (res.ok) return await res.json();
  } finally {
    clearTimeout(timer);
  }
  // 429: honour Retry-After once. 402 and others: no retry.
  if (res.status === 429 && !retried) {
    const ra = res.headers.get('retry-after');
    const ms = ra ? (Number.isFinite(Number(ra)) ? Number(ra) * 1000 : Date.parse(ra) - Date.now()) : 1000;
    await new Promise((r) => setTimeout(r, Math.max(0, Math.min(ms || 1000, 5000))));
    return requestJson(url, init, timeoutMs, true);
  }
  throw new HttpError(res.status);
}

const postJson = (url: string, headers: Record<string, string>, body: unknown) =>
  requestJson(url, { method: 'POST', headers, body });

export interface FetchedPage {
  url: string;
  title: string;
  /** With a prompt: only the reader model's answer. */
  content: string;
  publishedAt?: string;
}

/**
 * Keenable Fetch: GET /v1/fetch (keyed) or /v1/fetch/public (keyless). With `prompt`, a model reads the
 * page and `content` holds only its answer. Throws HttpError (404 = no page at that URL, 400 = bad URL).
 */
export async function keenableFetch(
  url: string,
  o: { prompt?: string; maxChars?: number; live?: boolean; timeoutMs?: number } = {},
): Promise<FetchedPage> {
  const keyed = !!process.env.KEENABLE_API_KEY;
  const qs = new URLSearchParams({ url });
  if (o.prompt) qs.set('prompt', o.prompt.slice(0, 2000));
  if (o.maxChars) qs.set('max_chars', String(o.maxChars));
  if (o.live !== undefined) qs.set('live', String(o.live));
  const headers: Record<string, string> = keyed
    ? { 'x-api-key': String(process.env.KEENABLE_API_KEY) }
    : { 'x-keenable-title': 'SusAgent' };
  const data = await requestJson(`${KEENABLE}/fetch${keyed ? '' : '/public'}?${qs}`, { method: 'GET', headers }, o.timeoutMs ?? 12_000);
  return {
    url: String(data?.url ?? url),
    title: String(data?.title ?? ''),
    content: String(data?.content ?? ''),
    publishedAt: data?.published_at ? String(data.published_at) : undefined,
  };
}

function keenableBody(query: string, o: SearchOptions) {
  const body: Record<string, unknown> = { query, mode: o.mode ?? 'realtime', max_results: MAX_RESULTS };
  if (o.sessionId) body.session_id = o.sessionId.slice(0, 128);
  if (o.queryTime) body.query_time = o.queryTime;
  if (o.publishedAfter) body.published_after = o.publishedAfter;
  return body;
}

function mapKeenable(data: any): SearchResult[] {
  return (data?.results ?? []).slice(0, MAX_RESULTS).map((r: any) => ({
    title: clip(r.title),
    url: String(r.url ?? ''),
    snippet: clip(r.snippet || r.description),
  }));
}

async function keenableKeyed(query: string, o: SearchOptions): Promise<SearchResult[]> {
  const body = keenableBody(query, o);
  if (o.sandboxFetch) {
    try {
      const r = mapKeenable(await o.sandboxFetch(`${KEENABLE}/search`, body));
      if (r.length) return r;
    } catch {
      /* sandbox path failed: direct call below */
    }
  }
  return mapKeenable(await postJson(`${KEENABLE}/search`, { 'x-api-key': String(process.env.KEENABLE_API_KEY) }, body));
}

async function keenablePublic(query: string, o: SearchOptions): Promise<SearchResult[]> {
  if (keenablePublicDown()) throw new Error('keenable public endpoint cooling down');
  try {
    const r = mapKeenable(await postJson(`${KEENABLE}/search/public`, { 'x-keenable-title': 'SusAgent' }, keenableBody(query, o)));
    notePublic(true);
    return r;
  } catch (err) {
    notePublic(false);
    throw err;
  }
}

async function linkup(query: string): Promise<SearchResult[]> {
  const data = await postJson(
    'https://api.linkup.so/v1/search',
    { authorization: `Bearer ${process.env.LINKUP_API_KEY}` },
    { q: query, depth: 'standard', outputType: 'searchResults' },
  );
  return (data?.results ?? []).slice(0, MAX_RESULTS).map((r: any) => ({
    title: clip(r.name ?? r.title),
    url: String(r.url ?? ''),
    snippet: clip(r.content ?? r.snippet),
  }));
}

async function exa(query: string): Promise<SearchResult[]> {
  const data = await postJson(
    'https://api.exa.ai/search',
    { 'x-api-key': String(process.env.EXA_API_KEY) },
    { query, numResults: MAX_RESULTS, contents: { text: { maxCharacters: SNIPPET_CHARS } } },
  );
  return (data?.results ?? []).slice(0, MAX_RESULTS).map((r: any) => ({
    title: clip(r.title),
    url: String(r.url ?? ''),
    snippet: clip(r.text ?? r.highlights?.[0] ?? r.summary),
  }));
}

async function tavily(query: string): Promise<SearchResult[]> {
  const key = String(process.env.TAVILY_API_KEY);
  const data = await postJson(
    'https://api.tavily.com/search',
    { authorization: `Bearer ${key}` },
    { query, max_results: MAX_RESULTS, search_depth: 'basic', topic: 'news' },
  );
  return (data?.results ?? []).slice(0, MAX_RESULTS).map((r: any) => ({
    title: clip(r.title),
    url: String(r.url ?? ''),
    snippet: clip(r.content),
  }));
}

/** Search with provider info; never throws. Cascade keenable > linkup > exa > tavily > (keyless keenable) > canned. */
export async function searchWebDetailed(query: string, o: SearchOptions = {}): Promise<DetailedSearch> {
  if (!o.forceMock && !forcedMock()) {
    const chain: ((q: string, o: SearchOptions) => Promise<SearchResult[]>)[] = [];
    if (process.env.KEENABLE_API_KEY) chain.push(keenableKeyed);
    if (process.env.LINKUP_API_KEY) chain.push(linkup);
    if (process.env.EXA_API_KEY) chain.push(exa);
    if (process.env.TAVILY_API_KEY) chain.push(tavily);
    if (!process.env.KEENABLE_API_KEY) chain.push(keenablePublic);
    for (const fn of chain) {
      try {
        const results = (await fn(query, o)).filter((r) => r.url || r.snippet);
        if (results.length) return { results, mock: false };
      } catch {
        /* 402 / 429-after-retry / timeout / network: next provider */
      }
    }
  }
  return { results: mockSearch(query, o.topic), mock: true };
}

export async function searchWeb(query: string): Promise<SearchResult[]> {
  return (await searchWebDetailed(query)).results;
}
