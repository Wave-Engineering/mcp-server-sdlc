import { execSync } from 'child_process';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';

const inputSchema = z.object({
  root: z.string().min(1).optional(),
});

function resolveRoot(explicit?: string): string {
  if (explicit && explicit.length > 0) return explicit;
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

function quoteArg(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const devspecLocateHandler: HandlerDef = {
  name: 'devspec_locate',
  description: 'Find docs/*-devspec.md files in a project root',
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

    const root = resolveRoot(args.root);

    try {
      // Verify root directory exists. `test -d` exits non-zero if missing,
      // which execSync throws on.
      try {
        execSync(`test -d ${quoteArg(root)}`, { encoding: 'utf8' });
      } catch {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: `root directory does not exist: ${root}`,
              }),
            },
          ],
        };
      }

      // docs/ missing is not an error — return an empty list.
      try {
        execSync(`test -d ${quoteArg(`${root}/docs`)}`, { encoding: 'utf8' });
      } catch {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ ok: true, files: [], count: 0 }),
            },
          ],
        };
      }

      // Glob via `find`. `-maxdepth 1` keeps it to direct children of docs/,
      // matching the `docs/*-devspec.md` shell-glob semantics.
      const cmd = `find docs -maxdepth 1 -type f -name '*-devspec.md'`;
      const output = execSync(cmd, {
        cwd: root,
        encoding: 'utf8',
      });

      const files = output
        .split('\n')
        .map(s => s.trim())
        .filter(s => s.length > 0)
        .sort();

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ ok: true, files, count: files.length }),
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

export default devspecLocateHandler;
