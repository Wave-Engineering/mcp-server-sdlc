import { execSync } from 'child_process';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';

const STAGES = ['concept', 'prd', 'backlog', 'implementation', 'dod'] as const;

const inputSchema = z.object({
  stage: z.enum(STAGES),
  root: z.string().min(1).optional(),
});

function resolveRoot(explicit?: string): string {
  if (explicit && explicit.length > 0) return explicit;
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

function quoteArg(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const campaignStageStartHandler: HandlerDef = {
  name: 'campaign_stage_start',
  description: 'Transition a campaign to start a new stage via campaign-status CLI',
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
      const output = execSync(`campaign-status stage-start ${quoteArg(args.stage)}`, {
        encoding: 'utf8',
        cwd: root,
      });
      // CLI says "Stage '<stage>' is now active." → derive new_state from CLI semantics.
      const trimmed = output.trim();
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              stage: args.stage,
              new_state: 'active',
              cli_output: trimmed,
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
              error: `campaign-status stage-start ${args.stage} failed: ${msg}`,
            }),
          },
        ],
      };
    }
  },
};

export default campaignStageStartHandler;
