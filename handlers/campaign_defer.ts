import { execSync } from 'child_process';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';

const inputSchema = z.object({
  item: z.string().min(1, 'item is required'),
  reason: z.string().min(1, 'reason is required'),
  root: z.string().min(1).optional(),
});

function resolveRoot(explicit?: string): string {
  if (explicit && explicit.length > 0) return explicit;
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

function quoteArg(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const campaignDeferHandler: HandlerDef = {
  name: 'campaign_defer',
  description: 'Defer a deliverable or work item with a rationale via campaign-status CLI',
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
      execSync(
        `campaign-status defer ${quoteArg(args.item)} --reason ${quoteArg(args.reason)}`,
        { encoding: 'utf8', cwd: root }
      );
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              item: args.item,
              reason: args.reason,
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
              error: `campaign-status defer failed: ${msg}`,
            }),
          },
        ],
      };
    }
  },
};

export default campaignDeferHandler;
