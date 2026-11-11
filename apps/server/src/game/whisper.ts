/**
 * Impostor "whisper": a vague gist of ONE crew answer (pure, deterministic).
 * Strips URLs/domains, money, percentages, numbers, dates; keeps only the main named entity.
 *   "Fal announced a $1.3B Series F this week" -> "someone mentioned Fal"
 * Returns null when nothing usable is left.
 */

const MONTHS =
  'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec';
const DAYS = 'monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thurs|fri|sat|sun';

/** Capitalized words that are not named entities (sentence starters, fillers, date words). */
const STOP = new Set(
  (
    'the a an i it its it\'s this that these those on in at by for from to of with as and or but so ' +
    'according per yes no not pretty sure probably maybe perhaps likely i\'m im i\'d i think believe ' +
    'couldn\'t could can\'t cannot nothing major big some most around about roughly approximately ' +
    'we they he she our my their his her there here what which who when where why how ' +
    'answer source sources q a: today yesterday tomorrow week month year this last next ' +
    'unknown unsure none n/a series round reportedly announced report reports news headline ' +
    'billion million thousand trillion percent ' +
    MONTHS.replace(/\|/g, ' ') +
    ' ' +
    DAYS.replace(/\|/g, ' ')
  ).split(/\s+/),
);

function clean(text: string): string {
  let s = ` ${text} `;
  s = s.replace(/\bhttps?:\/\/\S+/gi, ' '); // URLs
  s = s.replace(/\bwww\.\S+/gi, ' ');
  s = s.replace(/\b[\w-]+\.(com|org|net|io|ai|co|dev|news|gov|edu|app|xyz|info|tech|uk|us)\b\S*/gi, ' '); // bare domains
  s = s.replace(/[$€£¥]\s?\d[\d.,]*\s?(k|m|b|bn|mm|million|billion|trillion|thousand)?\b/gi, ' '); // money
  s = s.replace(/\b\d[\d.,]*\s?(%|percent|pct)/gi, ' '); // percentages
  s = s.replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' '); // ISO dates
  s = s.replace(/\b\d{1,2}[/.-]\d{1,2}([/.-]\d{2,4})?\b/g, ' '); // 10/11, 10/11/2026
  s = s.replace(new RegExp(`\\b(${MONTHS})\\.?\\s+\\d{1,2}(st|nd|rd|th)?(,?\\s+\\d{4})?\\b`, 'gi'), ' '); // Nov 10, 2026
  s = s.replace(new RegExp(`\\b\\d{1,2}(st|nd|rd|th)?\\s+(of\\s+)?(${MONTHS})\\b`, 'gi'), ' '); // 10 November
  s = s.replace(/(^|[\s(,;:])[-+~≈]?\d[\d.,]*(st|nd|rd|th|k|m|b|bn|x|wh\/kg|gw|mw|kw|gb|tb)?(?=$|[\s),.;:!?])/gi, ' '); // standalone numbers
  return s.replace(/\s+/g, ' ').trim();
}

/** A token that can be part of a named entity: starts uppercase, or mixed like "iPhone"/"n8n" is skipped. */
function isNameToken(tok: string): boolean {
  if (!/^[A-Z]/.test(tok)) return false;
  if (!/[A-Za-z]{2,}/.test(tok) && !/^[A-Z]$/.test(tok)) return false;
  if (STOP.has(tok.toLowerCase())) return false;
  if (/^Q\d$/.test(tok) || tok.includes('/')) return false;
  if (/^(wh|kwh|mwh|gwh|gw|mw|kw|gb|tb|mb|mph|km|kg|usd|eur|gbp)$/i.test(tok)) return false;
  return true;
}

const strip = (tok: string) => tok.replace(/^[^\w]+/, '').replace(/('s|’s)$/i, '').replace(/[^\w.+-]+$/, '').replace(/[.]+$/, '');

export function makeWhisper(answerText: string): string | null {
  if (!answerText || typeof answerText !== 'string') return null;
  // A quoted name ('Nod', "Gemini") is a strong signal.
  const quoted = answerText.match(/['"‘“]([A-Z][\w .+-]{1,40}?)['"’”]/);
  const s = clean(answerText);
  if (!s) return null;

  const tokens = s.split(' ').map((t) => ({ raw: t, word: strip(t) }));
  const candidates: string[] = [];
  let run: string[] = [];
  const flush = () => {
    // a lone single capital letter ("F") is not an entity
    if (run.length && !(run.length === 1 && run[0]!.length === 1)) candidates.push(run.slice(0, 4).join(' '));
    run = [];
  };
  for (const { raw, word } of tokens) {
    if (word && (isNameToken(word) || (run.length > 0 && /^[A-Z]$/.test(word)))) {
      run.push(word);
      // punctuation after the token ends the entity ("Fal, ..." / "Fal." / "Fal's")
      if (/[,.;:!?)]$|('s|’s)$/i.test(raw)) flush();
    } else flush();
  }
  flush();

  let entity: string | null = candidates[0] ?? null;
  if (!entity && quoted) {
    const q = clean(quoted[1]!);
    if (q && /[A-Za-z]{2,}/.test(q) && !STOP.has(q.toLowerCase())) entity = q;
  }
  if (!entity) return null;
  entity = entity.replace(/\s+/g, ' ').trim();
  if (entity.length < 2 || !/[A-Za-z]{2,}/.test(entity)) return null;
  return `someone mentioned ${entity}`;
}
