import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';

const inputSchema = z.object({
  plan_json: z.string().min(1, 'plan_json must be a non-empty JSON string'),
  extend: z.boolean().optional().default(false),
});

type Input = z.infer<typeof inputSchema>;

function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

function writePlanFile(planJson: string): string {
  const path = `/tmp/wave-init-plan-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`;
  writeFileSync(path, planJson);
  return path;
}

const waveInitHandler: HandlerDef = {
  name: 'wave_init',
  description: 'Initialize a wave plan from structured JSON; supports --extend mode',
  inputSchema,
  async execute(rawArgs: unknown) {
    let args: Input;
    try {
      args = inputSchema.parse(rawArgs);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error }) }],
      };
    }

    try {
      const planFile = writePlanFile(args.plan_json);
      const extendFlag = args.extend ? ' --extend' : '';
      const cmd = `wave-status init${extendFlag} ${planFile}`;
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

export default waveInitHandler;
