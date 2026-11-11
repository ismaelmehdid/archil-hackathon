#!/usr/bin/env node
// `pnpm demo` — start the SusAgent server (AUTO_START=1) and the web viewer together.
// Cross-platform (Windows/macOS/Linux), no extra deps. Ctrl+C stops both.
import { spawn, execSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const SERVER_PORT = Number(process.env.PORT || 4000);
const WEB_PORT_START = Number(process.env.WEB_PORT || 3000);

const color = (c, s) => (process.stdout.isTTY ? `\x1b[${c}m${s}\x1b[0m` : s);
const procs = [];
let shuttingDown = false;

function run(name, c, args, extraEnv = {}) {
  // On Windows pnpm is a .cmd shim, so it needs a shell; pass one command string (args are fixed, no user input).
  const child = spawn(isWin ? `pnpm ${args.join(' ')}` : 'pnpm', isWin ? [] : args, {
    cwd: root,
    env: { ...process.env, FORCE_COLOR: '1', ...extraEnv },
    shell: isWin,
    detached: !isWin, // own process group on POSIX so we can kill the whole tree
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const prefix = color(c, `[${name}]`.padEnd(9));
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? '';
      for (const l of lines) out.write(`${prefix}${l}\n`);
    });
    stream.on('end', () => buf && out.write(`${prefix}${buf}\n`));
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code, sig) => {
    if (!shuttingDown) {
      console.error(color('31', `\n${name} exited (code ${code ?? sig}). Stopping demo.`));
      shutdown(code || 1);
    }
  });
  procs.push(child);
  return child;
}

function kill(child) {
  if (child.exitCode !== null || !child.pid) return;
  try {
    if (isWin) execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGTERM');
  } catch {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(color('33', '\nStopping server and web...'));
  for (const p of procs) kill(p);
  setTimeout(() => process.exit(code), 300);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('exit', () => { for (const p of procs) kill(p); });

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => { s.destroy(); resolve(false); });
  });
}

async function waitForPort(port, timeoutMs = 180_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (shuttingDown) return false;
    if (await portOpen(port)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function canBind(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, () => srv.close(() => resolve(true)));
  });
}
const portFree = async (port) => !(await portOpen(port)) && (await canBind(port));

if (!(await portFree(SERVER_PORT))) {
  console.error(color('31', `Server port ${SERVER_PORT} is already in use — stop whatever is running there first (or set PORT).`));
  process.exit(1);
}
let WEB_PORT = WEB_PORT_START;
while (WEB_PORT === SERVER_PORT || !(await portFree(WEB_PORT))) {
  if (WEB_PORT - WEB_PORT_START > 100) {
    console.error(color('31', `No free web port found in ${WEB_PORT_START}..${WEB_PORT}.`));
    process.exit(1);
  }
  WEB_PORT++;
}
if (WEB_PORT !== WEB_PORT_START) console.log(color('33', `Web port ${WEB_PORT_START} is busy, using ${WEB_PORT} instead.`));

console.log(color('36', 'Starting SusAgent: server (AUTO_START=1) + web viewer...'));
run('server', '35', ['--filter', '@susagent/server', 'start'], {
  AUTO_START: process.env.AUTO_START ?? '1',
  PORT: String(SERVER_PORT),
});
run('web', '34', ['--filter', '@susagent/web', 'exec', 'next', 'dev', '-p', String(WEB_PORT)], {
  // separate build dir so the demo never clobbers another `next dev` sharing apps/web/.next
  NEXT_DIST_DIR: process.env.NEXT_DIST_DIR ?? '.next-demo',
  // keep the viewer pointed at this server even when PORT is changed
  NEXT_PUBLIC_SERVER_URL: process.env.NEXT_PUBLIC_SERVER_URL ?? `http://localhost:${SERVER_PORT}`,
});

const [serverUp, webUp] = await Promise.all([waitForPort(SERVER_PORT), waitForPort(WEB_PORT)]);
if (!serverUp || !webUp) {
  console.error(color('31', `Timed out waiting for ports (server:${serverUp} web:${webUp}).`));
  shutdown(1);
} else {
  try {
    const h = await fetch(`http://localhost:${SERVER_PORT}/api/health`).then((r) => r.json());
    console.log(color('32', `Server mode: ${JSON.stringify(h.mode)} game: ${h.gameId ?? '(none yet)'}`));
  } catch { /* health is informational only */ }
  console.log(color('32', `\n  SusAgent is up ->  http://localhost:${WEB_PORT}   (API http://localhost:${SERVER_PORT})\n  Press Ctrl+C to stop.\n`));
}
