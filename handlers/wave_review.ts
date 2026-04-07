import { execSync } from 'child_process';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';

const inputSchema = z.object({}).strict();

function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

const waveReviewHandler: HandlerDef = {
  name: 'wave_review',
  description: 'Signal transition to drift-check review phase',
  inputSchema,
  async execute(rawArgs: unknown) {
    try {
      inputSchema.parse(rawArgs);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error }) }],
      };
    }

    try {
      const output = execSync('wave-status review', {
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

export default waveReviewHandler;
