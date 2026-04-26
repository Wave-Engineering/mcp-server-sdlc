import { execSync } from 'child_process';
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

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function probePath(path: string): FsInfo {
  // `stat -c '%F|%s|%Y'` prints "<kind>|<size_bytes>|<mtime_secs>".
  // execSync throws on non-zero exit (missing path) — catch and report
  // exists:false so callers see a clean envelope rather than an exception.
  const statCmd = ['stat', '-c', '%F|%s|%Y', path].map(shellEscape).join(' ');
  let statOut: string;
  try {
    statOut = execSync(statCmd, { encoding: 'utf8' });
  } catch {
    return {
      exists: false,
      is_directory: false,
      empty: true,
      size_bytes: 0,
      last_modified: null,
    };
  }

  const parts = statOut.trim().split('|');
  const kind = parts[0] ?? '';
  const sizeBytes = parseInt(parts[1] ?? '0', 10) || 0;
  const mtimeSecs = parseInt(parts[2] ?? '0', 10) || 0;
  const isDirectory = kind === 'directory';

  let empty: boolean;
  if (isDirectory) {
    // For a directory, "empty" means no entries. `ls -A` lists everything
    // except '.' and '..'; empty stdout means an empty dir. If `ls` fails
    // for any reason (permissions, race), preserve the original semantics
    // by treating it as empty.
    const lsCmd = ['ls', '-A', path].map(shellEscape).join(' ');
    let lsOut = '';
    try {
      lsOut = execSync(lsCmd, { encoding: 'utf8' });
    } catch {
      lsOut = '';
    }
    empty = lsOut.trim().length === 0;
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
