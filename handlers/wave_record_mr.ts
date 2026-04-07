import { execSync } from 'child_process';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';

const inputSchema = z.object({
  issue_number: z.number().int().positive(),
  mr_ref: z.string().min(1, 'mr_ref must be a non-empty string'),
});

function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

function quoteArg(s: string): string {
  // Single-quote the arg and escape any embedded single quotes.
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const waveRecordMrHandler: HandlerDef = {
  name: 'wave_record_mr',
  description: 'Record the PR/MR reference that closed a wave issue',
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
      const cmd = `wave-status record-mr ${args.issue_number} ${quoteArg(args.mr_ref)}`;
      const output = execSync(cmd, {
        cwd: projectDir(),
        encoding: 'utf8',
      });
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ ok: true, data: output.trim() }) },
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

export default waveRecordMrHandler;
