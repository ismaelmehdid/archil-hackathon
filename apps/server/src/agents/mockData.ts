import type { SearchResult } from '@susagent/shared';

/** Canned referee question with answer key, wrong-but-plausible decoys and fake search hits. */
export interface BankQuestion {
  topic: string;
  text: string;
  answer: string;
  decoys: string[];
  results: SearchResult[];
}

function q(topic: string, text: string, answer: string, decoys: string[], site: string, detail: string): BankQuestion {
  const slug = answer.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return {
    topic,
    text,
    answer,
    decoys,
    results: [
      { title: `${answer} — ${topic}`, url: `https://${site}/news/${slug}`, snippet: `${detail} ${answer}.` },
      {
        title: `Roundup: ${topic}`,
        url: `https://news.example.com/roundup/${slug}`,
        snippet: `Analysts noted ${answer} as the headline item; rumors about ${decoys[0]} were not confirmed.`,
      },
    ],
  };
}

const T = [
  'AI funding rounds this week',
  'Space launches this month',
  'Electric vehicle battery breakthroughs',
  'Major open-source software releases this week',
  'Climate and energy policy news this week',
  'Big tech antitrust cases this month',
  'Semiconductor industry news this week',
  'Notable cybersecurity incidents this month',
] as const;

export const QUESTION_BANK: BankQuestion[] = [
  q(T[0], 'Which AI lab closed the largest funding round reported this week, and roughly how much did it raise?', 'Anthropic, about $13 billion', ['OpenAI, about $40 billion', 'Mistral, about $2 billion', 'xAI, about $6 billion'], 'techcrunch.com', 'The largest round of the week went to'),
  q(T[0], 'Which chipmaker led the week\'s biggest strategic investment in an AI startup?', 'Nvidia', ['AMD', 'Intel', 'Qualcomm'], 'reuters.com', 'The strategic lead investor was'),
  q(T[1], 'Which rocket flew the most orbital missions this month?', 'SpaceX Falcon 9', ['Rocket Lab Electron', 'ULA Vulcan', 'Blue Origin New Glenn'], 'spacenews.com', 'The month\'s busiest launcher was the'),
  q(T[1], 'Which agency launched a lunar lander mission this month?', 'ISRO', ['ESA', 'JAXA', 'NASA'], 'space.com', 'The lunar lander mission this month was launched by'),
  q(T[2], 'Which battery chemistry did the headline EV breakthrough this week use?', 'solid-state lithium-metal', ['sodium-ion', 'lithium-sulfur', 'silicon-anode LFP'], 'electrek.co', 'The breakthrough cells use'),
  q(T[2], 'Which automaker announced a 10-minute fast-charge battery pack this week?', 'BYD', ['Tesla', 'Toyota', 'Hyundai'], 'insideevs.com', 'The 10-minute pack was announced by'),
  q(T[3], 'Which major version of the Linux kernel was released this week?', 'Linux 6.18', ['Linux 6.16', 'Linux 7.0', 'Linux 6.12'], 'lwn.net', 'Linus Torvalds tagged'),
  q(T[3], 'Which JavaScript runtime shipped a new major release this week?', 'Node.js 26', ['Deno 3', 'Bun 2', 'Node.js 24'], 'nodejs.org', 'The new major release is'),
  q(T[4], 'Which country announced a new national carbon-pricing scheme this week?', 'Brazil', ['India', 'Indonesia', 'Mexico'], 'carbonbrief.org', 'The new carbon-pricing scheme was announced by'),
  q(T[4], 'Where is this year\'s UN climate summit (COP) being held?', 'Belem, Brazil', ['Baku, Azerbaijan', 'Dubai, UAE', 'Bonn, Germany'], 'unfccc.int', 'This year\'s COP is hosted in'),
  q(T[5], 'Which company faced the biggest new antitrust ruling this month?', 'Google', ['Apple', 'Amazon', 'Meta'], 'theverge.com', 'The biggest antitrust ruling of the month hit'),
  q(T[5], 'Which regulator opened the new app-store antitrust probe this month?', 'European Commission', ['US FTC', 'UK CMA', 'Japan JFTC'], 'politico.eu', 'The probe was opened by the'),
  q(T[6], 'Which foundry announced volume production of its 2nm process this week?', 'TSMC', ['Samsung', 'Intel Foundry', 'GlobalFoundries'], 'tomshardware.com', 'Volume 2nm production was announced by'),
  q(T[6], 'Which company reported record quarterly data-center revenue this week?', 'Nvidia', ['AMD', 'Broadcom', 'Intel'], 'cnbc.com', 'Record data-center revenue was reported by'),
  q(T[7], 'Which type of attack was behind the month\'s largest reported breach?', 'ransomware', ['SIM swapping', 'DDoS', 'insider leak'], 'bleepingcomputer.com', 'The largest breach of the month was caused by'),
  q(T[7], 'Which sector was hit hardest by cyberattacks this month?', 'healthcare', ['banking', 'retail', 'airlines'], 'therecord.media', 'The hardest-hit sector this month was'),
];

/** Generic fallback questions for topics without a bank entry. */
export function genericQuestions(topic: string): BankQuestion[] {
  return [
    q(topic, `In the news about "${topic}", which organization made the biggest headline this week?`, 'a major US tech company', ['a European regulator', 'a Chinese startup', 'a university lab'], 'news.example.com', 'The biggest headline came from'),
    q(topic, `About "${topic}": on which day of the week did the main announcement happen?`, 'Tuesday', ['Monday', 'Thursday', 'Friday'], 'news.example.com', 'The main announcement happened on'),
  ];
}

const STOP = new Set(
  'the a an of in on at to for and or is was this that which what who how did with by from week month this year be it its as are were has have about roughly much'.split(' '),
);

export function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9$.\s]/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/\.$/, ''))
    .filter((t) => t.length > 1 && !STOP.has(t));
}

export function jaccard(a: string, b: string): number {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Best bank question for a free-text query (null if nothing overlaps enough). */
export function matchBank(query: string, topic?: string): BankQuestion | null {
  const pool = [...QUESTION_BANK, ...(topic ? genericQuestions(topic) : [])];
  let best: BankQuestion | null = null;
  let bestScore = 0;
  for (const bq of pool) {
    const s = jaccard(query, bq.text) + (topic && bq.topic === topic ? 0.05 : 0);
    if (s > bestScore) {
      bestScore = s;
      best = bq;
    }
  }
  return bestScore >= 0.2 ? best : null;
}

export function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}
