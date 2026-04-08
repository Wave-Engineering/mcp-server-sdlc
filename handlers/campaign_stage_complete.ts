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

const campaignStageCompleteHandler: HandlerDef = {
  name: 'campaign_stage_complete',
  description: 'Mark a stage as complete via campaign-status CLI',
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
      const output = execSync(`campaign-status stage-complete ${quoteArg(args.stage)}`, {
        encoding: 'utf8',
        cwd: root,
      });
      // After completing dod, the campaign is fully complete.
      const campaignComplete = args.stage === 'dod';
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              stage: args.stage,
              campaign_complete: campaignComplete,
              cli_output: output.trim(),
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
              error: `campaign-status stage-complete ${args.stage} failed: ${msg}`,
            }),
          },
        ],
      };
    }
  },
};

export default campaignStageCompleteHandler;
