import { z } from 'zod';
import type { HandlerDef } from '../types.js';

const inputSchema = z.object({
  id: z.string().min(1, 'id must be a non-empty string'),
  evidence_path: z.string().min(1, 'evidence_path must be a non-empty string'),
});

interface FsInfo {
  exists: boolean;
  is_directory: boolean;
  empty: boolean;
  size_bytes: number;
  last_modified: string | null;
}

/**
 * Use Bun.spawnSync('stat', ...) to probe a path. Avoids node:fs so we
 * dodge mock.module('fs') pollution from sibling test files, and avoids
 * child_process so we dodge mock.module('child_process') pollution from
 * sibling test files that mock execSync.
 */
function probePath(path: string): FsInfo {
  const proc = Bun.spawnSync({
    cmd: ['stat', '-c', '%F|%s|%Y', path],
    stderr: 'pipe',
  });

  if (proc.exitCode !== 0) {
    return {
      exists: false,
      is_directory: false,
      empty: true,
      size_bytes: 0,
      last_modified: null,
    };
  }

  const out = new TextDecoder().decode(proc.stdout).trim();
  const parts = out.split('|');
  const kind = parts[0] ?? '';
  const sizeBytes = parseInt(parts[1] ?? '0', 10) || 0;
  const mtimeSecs = parseInt(parts[2] ?? '0', 10) || 0;
  const isDirectory = kind === 'directory';

  let empty: boolean;
  if (isDirectory) {
    // For a directory, "empty" means no entries.
    const ls = Bun.spawnSync({
      cmd: ['sh', '-c', `ls -A ${JSON.stringify(path)}`],
      stderr: 'pipe',
    });
    const lsOut = new TextDecoder().decode(ls.stdout).trim();
    empty = lsOut.length === 0;
  } else {
    empty = sizeBytes === 0;
  }

  return {
    exists: true,
    is_directory: isDirectory,
    empty,
    size_bytes: sizeBytes,
    last_modified: mtimeSecs > 0 ? new Date(mtimeSecs * 1000).toISOString() : null,
  };
}

const dodVerifyDeliverableHandler: HandlerDef = {
  name: 'dod_verify_deliverable',
  description: "Check whether a deliverable's evidence path exists and is non-empty",
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
      const info = probePath(args.evidence_path);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              id: args.id,
              evidence_path: args.evidence_path,
              ...info,
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

export default dodVerifyDeliverableHandler;
