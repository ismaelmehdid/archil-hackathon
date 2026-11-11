import type { DiskFile, DiskSnapshot, AgentId } from '@susagent/shared';

/** Minimal async file store used by every agent (Archil disk or in-memory). */
export interface AgentDisk {
  readonly agentId: AgentId;
  readonly backend: 'archil' | 'memory';
  readonly diskId?: string;
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  snapshot(): Promise<DiskSnapshot>;
  dispose(): Promise<void>;
}

/** In-memory disk (mock mode). Also used as a write-through cache by the Archil disk. */
export class MemoryDisk implements AgentDisk {
  readonly backend = 'memory' as const;
  readonly diskId?: string = undefined;
  readonly files = new Map<string, string>();
  constructor(readonly agentId: AgentId) {}

  async read(path: string): Promise<string | null> {
    return this.files.get(norm(path)) ?? null;
  }
  async write(path: string, content: string): Promise<void> {
    this.files.set(norm(path), content);
  }
  async snapshot(): Promise<DiskSnapshot> {
    return { agentId: this.agentId, backend: 'memory', files: toFiles(this.files) };
  }
  async dispose(): Promise<void> {
    /* keep contents so the post-game disk view still works */
  }
}

export function norm(path: string): string {
  return path.replace(/^\/+/, '');
}

export function toFiles(m: Map<string, string>): DiskFile[] {
  return [...m.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, content]) => ({ path, content }));
}
