import { execSync } from 'child_process';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';

const inputSchema = z.object({
  project_name: z.string().min(1, 'project_name is required'),
  root: z.string().min(1).optional(),
});

function resolveRoot(explicit?: string): string {
  if (explicit && explicit.length > 0) return explicit;
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

function quoteArg(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const campaignInitHandler: HandlerDef = {
  name: 'campaign_init',
  description: 'Initialize a campaign-status tracking directory for a project',
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

    // Verify root exists.
    try {
      execSync(`test -d ${quoteArg(root)}`, { encoding: 'utf8' });
    } catch {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ ok: false, error: `root not found: ${root}` }),
          },
        ],
      };
    }

    // Shell out to campaign-status init.
    try {
      execSync(`campaign-status init ${quoteArg(args.project_name)}`, {
        encoding: 'utf8',
        cwd: root,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ ok: false, error: `campaign-status init failed: ${msg}` }),
          },
        ],
      };
    }

    // Verify .sdlc/ was created.
    const sdlcDir = `${root}/.sdlc`;
    try {
      execSync(`test -d ${quoteArg(sdlcDir)}`, { encoding: 'utf8' });
    } catch {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: `.sdlc/ directory not created at ${sdlcDir}`,
            }),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            project_name: args.project_name,
            sdlc_dir: sdlcDir,
          }),
        },
      ],
    };
  },
};

export default campaignInitHandler;
