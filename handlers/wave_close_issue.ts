import { execSync } from 'child_process';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';

const inputSchema = z.object({
  issue_number: z.number().int().positive(),
});

function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

const waveCloseIssueHandler: HandlerDef = {
  name: 'wave_close_issue',
  description: 'Record that a wave issue has been closed',
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
      const output = execSync(`wave-status close-issue ${args.issue_number}`, {
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

export default waveCloseIssueHandler;
