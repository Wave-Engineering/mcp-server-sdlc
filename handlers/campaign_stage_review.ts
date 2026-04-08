import { execSync } from 'child_process';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';

// Only review-gated stages support stage-review.
const REVIEW_STAGES = ['concept', 'prd', 'dod'] as const;

const inputSchema = z.object({
  stage: z.enum(REVIEW_STAGES),
  root: z.string().min(1).optional(),
});

function resolveRoot(explicit?: string): string {
  if (explicit && explicit.length > 0) return explicit;
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

function quoteArg(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const campaignStageReviewHandler: HandlerDef = {
  name: 'campaign_stage_review',
  description: 'Mark a review-gated stage (concept|prd|dod) as in-review via campaign-status CLI',
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
      const output = execSync(`campaign-status stage-review ${quoteArg(args.stage)}`, {
        encoding: 'utf8',
        cwd: root,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              stage: args.stage,
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
              error: `campaign-status stage-review ${args.stage} failed: ${msg}`,
            }),
          },
        ],
      };
    }
  },
};

export default campaignStageReviewHandler;
