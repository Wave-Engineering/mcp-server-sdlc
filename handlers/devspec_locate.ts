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
  description: 'Find *-devspec.md files in conventional project locations: docs/, Docs/, docs/devspecs/, Docs/devspecs/',
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

      // Search multiple conventional locations. Missing directories are not
      // an error — skip them and continue. Collect union of all matches.
      const searchPaths = [
        'docs',
        'Docs',
        'docs/devspecs',
        'Docs/devspecs',
      ];

      const allFiles = new Set<string>();

      for (const searchPath of searchPaths) {
        // Check if this path exists
        try {
          execSync(`test -d ${quoteArg(`${root}/${searchPath}`)}`, { encoding: 'utf8' });
        } catch {
          // Path doesn't exist, skip it
          continue;
        }

        // For flat directories (docs/, Docs/), search at maxdepth 1.
        // For subdirectories (docs/devspecs/, Docs/devspecs/), also maxdepth 1
        // within that subdirectory to avoid recursion.
        const cmd = `find ${quoteArg(searchPath)} -maxdepth 1 -type f -name '*-devspec.md'`;
        try {
          const output = execSync(cmd, {
            cwd: root,
            encoding: 'utf8',
          });

          const files = output
            .split('\n')
            .map(s => s.trim())
            .filter(s => s.length > 0);

          for (const file of files) {
            allFiles.add(file);
          }
        } catch {
          // find command failed (directory might be empty or inaccessible), skip
          continue;
        }
      }

      const files = Array.from(allFiles).sort();

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
