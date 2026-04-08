import { execSync } from 'child_process';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';

const inputSchema = z.object({
  branch: z.string().min(1).optional(),
  root: z.string().min(1).optional(),
});

function resolveRoot(explicit?: string): string {
  if (explicit && explicit.length > 0) return explicit;
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

function quoteArg(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const campaignDashboardUrlHandler: HandlerDef = {
  name: 'campaign_dashboard_url',
  description: 'Return the SDLC dashboard viewer URL for the current project',
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
    const branchArg = args.branch ? ` --branch ${quoteArg(args.branch)}` : '';

    try {
      const output = execSync(`campaign-status dashboard-url${branchArg}`, {
        encoding: 'utf8',
        cwd: root,
      });
      const url = output.trim();
      if (url.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: 'campaign-status dashboard-url returned empty output',
              }),
            },
          ],
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, url }) }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: `campaign-status dashboard-url failed: ${msg}`,
            }),
          },
        ],
      };
    }
  },
};

export default campaignDashboardUrlHandler;
