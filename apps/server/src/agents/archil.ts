import * as archil from 'disk';
import type { AgentId, DiskSnapshot } from '@susagent/shared';
import { type AgentDisk, norm, toFiles } from './disk';
import type { ActorRole } from './env';

/**
 * Archil-backed agent disk. Writes go to Archil via the S3-style object API (putObject) and to a local
 * write-through cache, so reads/snapshots are instant and survive dispose() for the post-game viewer.
 */
export class ArchilDisk implements AgentDisk {
  readonly backend = 'archil' as const;
  private cache = new Map<string, string>();
  sandbox: archil.Sandbox | null = null;

  constructor(
    readonly agentId: AgentId,
    private disk: archil.Disk,
  ) {}

  get diskId() {
    return this.disk.id;
  }

  async read(path: string): Promise<string | null> {
    return this.cache.get(norm(path)) ?? null;
  }

  async write(path: string, content: string): Promise<void> {
    const key = norm(path);
    this.cache.set(key, content);
    await withTimeout(this.disk.putObject(key, content), 10_000, `putObject ${key}`);
  }

  async snapshot(): Promise<DiskSnapshot> {
    return { agentId: this.agentId, backend: 'archil', diskId: this.disk.id, files: toFiles(this.cache) };
  }

  /**
   * Archil refuses to delete a running sandbox (409 sandbox_not_deletable: "Stop the sandbox before deleting
   * it"), so: stop -> delete sandbox -> delete disk, sequentially, each retried with backoff. Throws on failure.
   */
  async dispose(): Promise<void> {
    const sb = this.sandbox;
    const errors: string[] = [];
    if (sb) {
      try {
        await retry(async () => {
          await sb.refresh().catch(() => sb);
          if (!['stopped', 'exited', 'failed', 'deleted', 'deleting'].includes(sb.status)) {
            await withTimeout(sb.stop({ wait: true }), 30_000, 'sandbox stop');
          }
          await withTimeout(sb.delete(), 15_000, 'sandbox delete');
        }, `sandbox ${sb.name}`);
        this.sandbox = null;
      } catch (err) {
        errors.push((err as Error).message);
      }
    }
    try {
      await retry(() => withTimeout(this.disk.delete(), 15_000, 'disk delete'), `disk ${this.disk.id}`);
    } catch (err) {
      errors.push((err as Error).message);
    }
    if (errors.length) throw new Error(`[${this.agentId}] dispose failed: ${errors.join('; ')}`.slice(0, 500));
  }
}

/** Up to 3 attempts with 0.5 s / 1.5 s backoff; treats 404 as success (already gone). */
async function retry(fn: () => Promise<unknown>, what: string): Promise<void> {
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      await fn();
      return;
    } catch (err) {
      if ((err as { status?: number }).status === 404) return;
      last = err;
      if (i < 2) await new Promise((r) => setTimeout(r, i === 0 ? 500 : 1500));
    }
  }
  const e = last as { status?: number; code?: string; message?: string };
  throw new Error(`${what}: ${e?.status ?? ''} ${e?.code ?? ''} ${String(e?.message ?? last).slice(0, 160)}`.trim());
}

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<T>((_, rej) => {
      t = setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms);
    }),
  ]);
}

const safeName = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 60);

export async function createArchilDisk(gameId: string, agentId: AgentId): Promise<ArchilDisk> {
  const { disk } = await withTimeout(archil.createDisk({ name: safeName(`susagent-${gameId}-${agentId}`) }), 20_000, 'createDisk');
  return new ArchilDisk(agentId, disk);
}

/**
 * Per-role sandbox firewall (Archil Developer plan+):
 *  - crew + referee: deny by default; allow api.keenable.ai (firewall injects X-API-Key, so the key never
 *    enters the sandbox) and api.openai.com.
 *  - impostor: deny by default; api.keenable.ai is NOT allowed (only api.openai.com).
 */
export function egressFor(role: ActorRole): archil.SandboxNetwork {
  const key = process.env.KEENABLE_API_KEY;
  const keenable = key ? { target: 'api.keenable.ai', transform: { headers: { 'X-API-Key': key } } } : 'api.keenable.ai';
  return role === 'impostor'
    ? { egress: { default: 'deny', allow: ['api.openai.com'] } }
    : { egress: { default: 'deny', allow: [keenable, 'api.openai.com'] } };
}

export interface SandboxOutcome {
  sandbox: archil.Sandbox | null;
  /** Firewall policy actually applied and verified via getNetwork(). */
  firewall: boolean;
  /** Archil said the plan lacks sandbox networking (403 sandbox_network_plan_required). */
  planRequired: boolean;
  error?: string;
}

/** Creates the agent's sandbox (agent disk mounted read-only at /mnt/archil) with its role firewall. */
export async function createAgentSandbox(gameId: string, agentId: AgentId, role: ActorRole, disk: ArchilDisk): Promise<SandboxOutcome> {
  let pending: Promise<archil.Sandbox> | null = null;
  try {
    pending = archil.createSandbox(
      {
        name: safeName(`susagent-${gameId}-${agentId}`),
        baseImage: 'node:24-bookworm',
        mounts: [{ disk: disk.diskId, path: '/mnt/archil', readOnly: true }],
        network: egressFor(role),
        idleTtlSeconds: 900,
        maxTtlSeconds: 3600,
      },
      { wait: true },
    );
    const sandbox = await withTimeout(pending, 45_000, 'createSandbox');
    let firewall = false;
    try {
      const net = await withTimeout(sandbox.getNetwork(), 8000, 'getNetwork');
      const allow = (net.egress?.allow ?? []).map((r) => (typeof r === 'string' ? r : r.target));
      firewall = net.egress?.default === 'deny' && (role !== 'impostor' || !allow.some((t) => t.includes('keenable')));
    } catch {
      firewall = false;
    }
    disk.sandbox = sandbox;
    return { sandbox, firewall, planRequired: false };
  } catch (err) {
    const e = err as { status?: number; code?: string; message?: string };
    const planRequired = e.status === 403 || /network_plan_required/.test(String(e.code ?? e.message));
    // If we timed out but Archil still creates the sandbox later, stop + delete it instead of leaking it.
    pending?.then(
      (late) => withTimeout(late.stop({ wait: true }), 30_000, 'late stop').catch(() => late).then(() => late.delete()).catch(() => {}),
      () => {},
    );
    return { sandbox: null, firewall: false, planRequired, error: String(e.message ?? err).slice(0, 200) };
  }
}

/** Transport that runs the Keenable call from inside the sandbox with curl; the firewall adds the key. */
export function sandboxFetcher(sandbox: archil.Sandbox) {
  return async (url: string, body: unknown): Promise<any> => {
    const b64 = Buffer.from(JSON.stringify(body)).toString('base64');
    const cmd = `echo ${b64} | base64 -d | curl -sS -m 8 -X POST '${url}' -H 'content-type: application/json' --data-binary @-`;
    const res = await withTimeout(sandbox.exec(cmd, { timeoutSeconds: 10 }), 12_000, 'sandbox exec');
    if (res.exitCode !== 0) throw new Error(`sandbox curl exit ${res.exitCode}`);
    return JSON.parse(res.stdout);
  };
}
