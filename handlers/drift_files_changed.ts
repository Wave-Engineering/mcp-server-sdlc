import { execSync } from 'child_process';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';

const inputSchema = z.object({
  from_ref: z.string().min(1, 'from_ref must be a non-empty string'),
  to_ref: z.string().optional().default('HEAD'),
});

function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

function quoteArg(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const driftFilesChangedHandler: HandlerDef = {
  name: 'drift_files_changed',
  description: 'List files changed between two git refs',
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
      const cmd = `git diff --name-only ${quoteArg(args.from_ref)}..${quoteArg(args.to_ref)}`;
      const output = execSync(cmd, {
        cwd: projectDir(),
        encoding: 'utf8',
      });
      const files = output
        .split('\n')
        .map(s => s.trim())
        .filter(s => s.length > 0);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              from_ref: args.from_ref,
              to_ref: args.to_ref,
              files,
              count: files.length,
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

export default driftFilesChangedHandler;
