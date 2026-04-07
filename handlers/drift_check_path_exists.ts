import { isAbsolute, join } from 'path';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';

const inputSchema = z.object({
  path: z.string().min(1, 'path must be a non-empty string'),
  kind: z.enum(['file', 'directory', 'any']).optional().default('any'),
});

function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

function resolvePath(path: string): string {
  return isAbsolute(path) ? path : join(projectDir(), path);
}

async function probe(absPath: string): Promise<{ exists: boolean; kind: 'file' | 'directory' | null }> {
  // Use Bun.spawnSync('stat', ...) to distinguish file vs directory
  // without touching node:fs or child_process (both have mock collisions
  // with sibling tests).
  const proc = Bun.spawnSync({
    cmd: ['stat', '-c', '%F', absPath],
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) {
    return { exists: false, kind: null };
  }
  const out = new TextDecoder().decode(proc.stdout).trim();
  if (out === 'directory') return { exists: true, kind: 'directory' };
  // 'regular file', 'regular empty file', 'symbolic link' (resolved), etc.
  return { exists: true, kind: 'file' };
}

const driftCheckPathExistsHandler: HandlerDef = {
  name: 'drift_check_path_exists',
  description: 'Check whether a file path exists in the current working tree',
  inputSchema,
  async execute(rawArgs: unknown) {
    let args: z.infer<typeof inputSchema>;
    try {
      args = inputSchema.parse(rawArgs);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error }) }],
      };
    }

    try {
      const abs = resolvePath(args.path);
      const result = await probe(abs);

      let exists = result.exists;
      if (exists && args.kind !== 'any' && result.kind !== args.kind) {
        // Path exists but of the wrong kind — return exists=false to match spec.
        exists = false;
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              path: args.path,
              resolved: abs,
              exists,
              actual_kind: result.exists ? result.kind : null,
              requested_kind: args.kind,
            }),
          },
        ],
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error }) }],
      };
    }
  },
};

export default driftCheckPathExistsHandler;
