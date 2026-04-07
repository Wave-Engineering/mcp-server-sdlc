import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';

const inputSchema = z.object({
  plan_json: z.string().min(1, 'plan_json must be a non-empty JSON string'),
});

function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

function writePlanFile(planJson: string): string {
  const path = `/tmp/wave-flight-plan-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`;
  writeFileSync(path, planJson);
  return path;
}

const waveFlightPlanHandler: HandlerDef = {
  name: 'wave_flight_plan',
  description: 'Store the flight plan for the current wave',
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
      const planFile = writePlanFile(args.plan_json);
      const output = execSync(`wave-status flight-plan ${planFile}`, {
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

export default waveFlightPlanHandler;
