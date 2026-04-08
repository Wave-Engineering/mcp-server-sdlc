import { execSync } from 'child_process';
import { dirname } from 'path';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';

const inputSchema = z.object({
  path: z.string().min(1, 'path must be a non-empty string'),
});

function quoteArg(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const dddVerifyCommittedHandler: HandlerDef = {
  name: 'ddd_verify_committed',
  description: 'Verify a file has no uncommitted git changes (gate for /ddd accept)',
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

    // Verify the file exists (`test -e` for either file or symlink).
    try {
      execSync(`test -e ${quoteArg(args.path)}`, { encoding: 'utf8' });
    } catch {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ ok: false, error: `file not found: ${args.path}` }),
          },
        ],
      };
    }

    // Run git status --porcelain with cwd set to the file's containing directory,
    // so git can resolve the containing repo correctly.
    const fileDir = dirname(args.path) || '.';
    try {
      const output = execSync(
        `git status --porcelain -- ${quoteArg(args.path)}`,
        { encoding: 'utf8', cwd: fileDir }
      );

      // Preserve leading whitespace — the XY status prefix (e.g. ' M', '??') is meaningful.
      // Only strip a trailing newline.
      const stripped = output.replace(/\n+$/, '');
      if (stripped.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ ok: true, path: args.path, committed: true }),
            },
          ],
        };
      }

      // Uncommitted changes — return the first status line (still includes XY prefix).
      const firstLine = stripped.split('\n')[0];
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              path: args.path,
              committed: false,
              status: firstLine,
            }),
          },
        ],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: `git status failed (not a git repo?): ${msg}`,
            }),
          },
        ],
      };
    }
  },
};

export default dddVerifyCommittedHandler;
