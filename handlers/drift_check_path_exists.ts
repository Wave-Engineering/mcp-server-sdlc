import { execSync } from 'child_process';
import { isAbsolute, join } from 'path';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { emitStateEvent } from '../lib/flightdeck_emit.js';

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

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function probe(absPath: string): { exists: boolean; kind: 'file' | 'directory' | null } {
  // `stat -c %F` prints "regular file" / "directory" / "symbolic link" / etc.
  // execSync throws on non-zero exit (i.e. path missing) — catch and report
  // exists:false so callers don't need to distinguish missing from error.
  const cmd = ['stat', '-c', '%F', absPath].map(shellEscape).join(' ');
  let stdout: string;
  try {
    stdout = execSync(cmd, { encoding: 'utf8' });
  } catch {
    return { exists: false, kind: null };
  }
  const out = stdout.trim();
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
      const result = probe(abs);

      let exists = result.exists;
      if (exists && args.kind !== 'any' && result.kind !== args.kind) {
        // Path exists but of the wrong kind — return exists=false to match spec.
        exists = false;
      }

      // FlightDeck emit (S1.5, additive) — drift=1 when an expected path is
      // absent (or wrong kind), else 0. Fire-and-forget; response unchanged.
      emitStateEvent(projectDir(), 'metric', {
        metric: 'drift',
        value: exists ? 0 : 1,
        unit: 'count',
        label: exists ? 'path-present' : 'path-missing',
        detail: { path: args.path, exists, requested_kind: args.kind },
      });

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
