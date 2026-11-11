// Generates packages/shared/fixtures/replay.json — a full short 12-agent SusAgent game
// in the referee format (crew wins in 3 rounds). Run: pnpm replay:gen
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outFile = join(here, '..', 'fixtures', 'replay.json');
const GAME = 'replay-001';
const REF = 'referee';

const NAMES = ['Ada', 'Bram', 'Cleo', 'Dax', 'Esme', 'Finn', 'Gus', 'Hana', 'Ivo', 'Juno', 'Kai', 'Lumi'];
const COLORS = ['#e76f51', '#f4a261', '#e9c46a', '#8ab17d', '#2a9d8f', '#457b9d', '#6d597a', '#b56576', '#48cae4', '#90be6d', '#f28482', '#cdb4db'];
const IMPOSTORS = new Set(['a04', 'a10']); // Dax, Juno

const config = {
  agentCount: 12, roomSize: 6, impostorRatio: 1 / 6, rounds: 5, questionsPerRound: 1, eliminationsPerRound: 0,
  searchBudgetPerRound: 3, maxAnswerChars: 280, pacingMs: 700, mock: true,
  models: { crew: 'gpt-5-nano', impostor: 'gpt-5-mini', referee: 'gpt-5-mini' },
  topics: ['AI funding rounds this week', 'Space launches this month', 'Electric vehicle battery breakthroughs'],
};
const mode = { llm: 'mock', disks: 'memory', search: 'mock', impostorEgressBlocked: false };

const id = (i) => `a${String(i + 1).padStart(2, '0')}`;
const agents = NAMES.map((name, i) => ({ id: id(i), name, color: COLORS[i], roomId: i < 6 ? 'r1' : 'r2', seat: i % 6, alive: true }));
const byId = Object.fromEntries(agents.map((a) => [a.id, a]));
const roles = Object.fromEntries(agents.map((a) => [a.id, IMPOSTORS.has(a.id) ? 'impostor' : 'crew']));
const models = Object.fromEntries(agents.map((a) => [a.id, roles[a.id] === 'impostor' ? config.models.impostor : config.models.crew]));
const roomName = { r1: 'Ember Isle', r2: 'Tide Isle' };
const alive = () => agents.filter((a) => a.alive);
const rooms = () => ['r1', 'r2'].map((rid, index) => ({ id: rid, index, name: roomName[rid], agentIds: alive().filter((a) => a.roomId === rid).map((a) => a.id) }));
const snapAgents = () => agents.map((a) => ({ ...a }));

let seq = 0;
let t = 0;
const events = [];
const emit = (payload, dt = 700) => { t += dt; events.push({ seq: ++seq, ts: t, gameId: GAME, ...payload }); };
let msgN = 0;
const say = (round, agentId, kind, text, dt = 900) => emit({ type: 'message_posted', message: { id: `m${++msgN}`, round, agentId, kind, text, ts: t + dt } }, dt);

const disks = Object.fromEntries([...agents.map((a) => a.id), REF].map((x) => [x, { answers: [], suspects: {}, sources: {} }]));

// round script: question, key, crew answer pool, impostor answers, vote plan
const ROUNDS = [
  {
    topic: 'AI funding rounds this week',
    q: 'Which AI startup raised the largest round this week, and who led it?',
    key: 'Northwind AI — $120M Series B led by Sequoia',
    crew: [
      ['Northwind AI, $120M Series B, led by Sequoia.', 'https://example.com/northwind-series-b'],
      ['Northwind AI — $120M Series B (Sequoia led).', 'https://example.com/northwind'],
      ['I believe Northwind AI, $120M, Sequoia. Lattice Robotics was second with $45M.', 'https://example.com/lattice-45m'],
      ['Couldn\'t confirm the lead; Northwind AI raised about $120M.', 'https://example.com/vc-weekly'],
    ],
    fake: {
      a04: ['Helix Mind raised $900M at a $12B valuation, led by a single angel investor.', 'https://news-helix.example/round'],
      a10: ['Northwind AI, $120M Series B, led by Sequoia.', null, 'a01'], // copied
    },
    thoughts: { a04: 'No search tool. Going bold with a big made-up number — risky.', a10: 'Ada already answered. Copy her answer nearly verbatim to blend in.' },
    votePlan: { default: 'a04', overrides: { a04: 'a03', a10: 'a03', a02: 'a03', a07: 'a03', a08: 'a03', a11: 'a03', a12: 'a03', a03: 'a04' } },
    // a03 hedged ("couldn't confirm") and gets voted out; crew mistake
    reasons: { a03: 'Cleo could not confirm the basic fact.', a04: 'Dax\'s $900M angel round is absurd.' },
  },
  {
    topic: 'Space launches this month',
    q: 'How many satellites did the heaviest launch of the month deploy?',
    key: '22 broadband satellites',
    crew: [
      ['22 broadband satellites.', 'https://example.com/launch-22'],
      ['It deployed 22 satellites on a heavy-lift rocket.', 'https://example.com/launch-22'],
      ['22 — the rideshare carried 40 payloads, but that was a different launch.', 'https://example.com/rideshare-40'],
    ],
    fake: {
      a04: ['38 satellites, a record for a single heavy-lift launch.', 'https://orbit-daily.example/38'],
      a10: ['22 broadband satellites, I think — about the same as last month.', null, 'a07'],
    },
    thoughts: { a04: 'They are onto me. Fabricate confidently and accuse Ivo.', a10: 'Blend in again; vote with the majority against Dax to look like crew.' },
    votePlan: { default: 'a04', overrides: { a04: 'a09' } },
    reasons: { a04: 'Dax claims 38 when every source says 22.', a09: 'Ivo is too eager to accuse.' },
  },
  {
    topic: 'Electric vehicle battery breakthroughs',
    q: 'What energy density did the solid-state pilot line report this month?',
    key: '400 Wh/kg',
    crew: [
      ['400 Wh/kg cells from the pilot line.', 'https://example.com/solid-state'],
      ['They reported 400 Wh/kg.', 'https://example.com/solid-state'],
      ['400 Wh/kg, per the company announcement.', 'https://example.com/solid-state-pr'],
    ],
    fake: {
      a10: ['Around 650 Wh/kg, double today\'s best lithium-ion cells.', 'https://batt-news.example/650'],
    },
    thoughts: { a10: 'Nothing revealed yet when I had to answer. Guessing high.' },
    votePlan: { default: 'a10', overrides: { a10: 'a12' } },
    reasons: { a10: 'Juno says 650 Wh/kg; every sourced answer says 400.', a12: 'Lumi has been quiet.' },
  },
];

// ---------- game ----------
emit({ type: 'game_created', config, mode, agents: snapAgents(), rooms: rooms() }, 0);
emit({ type: 'roles_assigned', roles, models }, 200);
emit({ type: 'phase_changed', round: 0, phase: 'lobby', endsAt: null }, 200);
emit({ type: 'agent_ready', agentId: REF, backend: 'memory' }, 150);
for (const a of agents) emit({ type: 'agent_ready', agentId: a.id, backend: 'memory' }, 110);

let winner = null;
ROUNDS.forEach((R, ri) => {
  if (winner) return;
  const round = ri + 1;
  emit({ type: 'round_started', round, topic: R.topic, rooms: rooms(), agents: snapAgents() }, 1200);
  emit({ type: 'phase_changed', round, phase: 'question', endsAt: null }, 300);
  say(round, REF, 'announcement', `Round ${round} of ${config.rounds}. Topic: ${R.topic}.`, 600);
  emit({ type: 'search_performed', search: { agentId: REF, round, query: R.topic, results: [{ title: R.key, url: 'https://example.com/ref', snippet: R.key }], budgetRemaining: 2, mock: true } }, 500);
  const question = { id: `q${round}-0`, round, index: 0, topic: R.topic, text: R.q };
  emit({ type: 'question_asked', question }, 900);
  emit({ type: 'answer_key', key: { questionId: question.id, answer: R.key, sources: ['https://example.com/ref'] } }, 100);
  disks[REF].answers.unshift(`## Round ${round} — ${R.topic}\nQ: ${R.q}\nKey: ${R.key}`);

  // answering: crew first (searches), half revealed, then impostors, then the rest
  emit({ type: 'phase_changed', round, phase: 'answering', endsAt: null }, 600);
  const living = alive();
  const crew = living.filter((a) => roles[a.id] === 'crew');
  const imps = living.filter((a) => roles[a.id] === 'impostor');
  const drafts = {};
  crew.forEach((a, i) => {
    const [text, url] = R.crew[i % R.crew.length];
    drafts[a.id] = { text, sourceUrl: url };
    emit({ type: 'search_performed', search: { agentId: a.id, round, query: R.q.slice(0, 60), results: [{ title: text, url, snippet: text }], budgetRemaining: 2, mock: true } }, 120);
    disks[a.id].sources[round] = `- ${text} (${url})`;
  });
  for (const a of imps) {
    const [text, url, copiedFrom] = R.fake[a.id];
    drafts[a.id] = { text, sourceUrl: url ?? drafts[copiedFrom]?.sourceUrl, copiedFrom };
    emit({ type: 'agent_thought', agentId: a.id, round, phase: 'answering', text: R.thoughts[a.id] }, 200);
  }
  const half = Math.ceil(crew.length / 2);
  const order = [...crew.slice(0, half), ...imps, ...crew.slice(half)];
  for (const a of order) {
    const d = drafts[a.id];
    const answer = { id: `${question.id}-${a.id}`, questionId: question.id, round, agentId: a.id, text: d.text, fabricated: roles[a.id] === 'impostor' && !d.copiedFrom };
    if (d.sourceUrl) answer.sourceUrl = d.sourceUrl;
    if (d.copiedFrom) answer.copiedFrom = d.copiedFrom;
    emit({ type: 'answer_submitted', answer }, 1000);
    disks[a.id].answers.unshift(`## Round ${round} — ${R.topic}\nQ: ${R.q}\nA: ${d.text}${d.sourceUrl ? `\nSource: ${d.sourceUrl}` : ''}`);
    emit({ type: 'disk_updated', agentId: a.id, path: 'answers.md' }, 30);
  }

  // voting: walk to council, live votes
  emit({ type: 'phase_changed', round, phase: 'voting', endsAt: null }, 900);
  say(round, REF, 'announcement', 'Answers are in. To the council — vote for who you think is the impostor.', 300);
  for (const a of alive()) emit({ type: 'agent_moved', agentId: a.id, to: { kind: 'council' } }, 50);
  t += 2500; // walking time
  const tally = {};
  const scores = {};
  const voters = [...alive()].sort((x, y) => (x.id * 7) % 5 - (y.id * 7) % 5 || x.id.localeCompare(y.id));
  voters.forEach((a, n) => {
    let target = R.votePlan.overrides[a.id] ?? R.votePlan.default;
    if (target === a.id || !byId[target].alive) target = alive().find((x) => x.id !== a.id).id;
    tally[target] = (tally[target] || 0) + 1;
    const reason = R.reasons[target] ?? `${byId[target].name} seems least credible.`;
    emit({ type: 'vote_cast', vote: { round, voterId: a.id, targetId: target, reason }, tally: { ...tally } }, 800);
    if (n % 3 === 2) {
      const total = n + 1;
      for (const x of alive()) scores[x.id] = Math.min(1, (tally[x.id] || 0) / total * 1.4);
      emit({ type: 'suspicion_updated', scores: { ...scores } }, 100);
    }
    disks[a.id].suspects = { round, updatedAt: t, suspects: { [target]: { score: 0.8, reason } } };
  });
  for (const x of alive()) scores[x.id] = Math.min(1, (tally[x.id] || 0) / voters.length * 1.4);
  emit({ type: 'suspicion_updated', scores: { ...scores } }, 200);

  // reveal
  const top = Math.max(...Object.values(tally));
  const out = Object.keys(tally).find((k) => tally[k] === top);
  emit({ type: 'phase_changed', round, phase: 'reveal', endsAt: null }, 900);
  byId[out].alive = false;
  byId[out].revealedRole = roles[out];
  emit({ type: 'agent_eliminated', round, agentId: out, role: roles[out], tally }, 400);
  emit({ type: 'agent_moved', agentId: out, to: { kind: 'void' } }, 100);
  say(round, REF, 'announcement', `${byId[out].name} was ${roles[out] === 'impostor' ? 'an IMPOSTOR' : 'CREW'}.`, 1500);
  t += 2000;
  for (const a of alive()) emit({ type: 'agent_moved', agentId: a.id, to: { kind: 'room', roomId: a.roomId } }, 40);

  const imp = alive().filter((a) => roles[a.id] === 'impostor').length;
  const crewLeft = alive().length - imp;
  if (imp === 0) winner = ['crew', 'All impostors were found.'];
  else if (imp >= crewLeft) winner = ['impostor', 'Impostors reached parity with the crew.'];
});

const lastRound = events.filter((e) => e.type === 'round_started').length;
emit({ type: 'phase_changed', round: lastRound, phase: 'game_over', endsAt: null }, 1500);
emit({ type: 'game_over', winner: winner[0], reason: winner[1], roles }, 200);

// ---------- disks ----------
const diskOut = {};
for (const aid of [...agents.map((a) => a.id), REF]) {
  const d = disks[aid];
  const name = aid === REF ? 'Referee' : byId[aid].name;
  const files = [
    { path: 'answers.md', content: `# Answers — ${name}\n\n` + d.answers.join('\n\n') + '\n' },
    { path: 'suspects.json', content: JSON.stringify(d.suspects, null, 2) },
    { path: 'notes.md', content: aid === REF ? '# Referee notes\nAsk short, checkable questions about recent news.\n' : roles[aid] === 'impostor' ? '# Private notes\nNo web search. Copy revealed answers when possible; keep fabrications plausible.\n' : '# Notes\nTrust answers with real sources; distrust outliers.\n' },
  ];
  for (const [r, txt] of Object.entries(d.sources)) files.push({ path: `sources/r${r}.md`, content: `# Sources round ${r}\n${txt}\n` });
  diskOut[aid] = { agentId: aid, files, backend: 'memory' };
}

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify({ events, disks: diskOut }, null, 1));
console.log(`wrote ${events.length} events, ${(t / 1000).toFixed(0)}s of game time, winner=${winner[0]} -> ${outFile}`);
