import { execSync } from 'child_process';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';

const inputSchema = z.object({
  description: z.string().min(1, 'description must be a non-empty string'),
  risk: z.enum(['low', 'medium', 'high']),
});

function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

function quoteArg(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const waveDeferHandler: HandlerDef = {
  name: 'wave_defer',
  description: 'Record a deferral with description and risk level',
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
      const cmd = `wave-status defer ${quoteArg(args.description)} ${args.risk}`;
      const output = execSync(cmd, {
        cwd: projectDir(),
        encoding: 'utf8',
      }).trim();
      // #425: `wave-status defer` RECORDS the deferral (it saves state and
      // regenerates the dashboard) but prints NOTHING on success — unlike its
      // sibling wave-status commands, which emit an envelope. A bare exit-0
      // therefore left this returning `{ ok: true, data: "" }`, which reads as a
      // no-op even though the deferral landed, forcing callers to follow up with
      // wave_show to confirm. Exit 0 means the CLI reached its save step, so
      // surface a structured confirmation of what was recorded. `data` is
      // retained (additive, non-breaking) and still carries any CLI output if a
      // future version starts emitting one.
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              deferral: {
                description: args.description,
                risk: args.risk,
                status: 'pending',
              },
              data: output || `deferral recorded (${args.risk}): ${args.description}`,
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

export default waveDeferHandler;
