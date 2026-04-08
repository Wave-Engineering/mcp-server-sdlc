import { execSync } from 'child_process';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';

const inputSchema = z.object({
  root: z.string().min(1).optional(),
});

function resolveRoot(explicit?: string): string {
  if (explicit && explicit.length > 0) return explicit;
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

function quoteArg(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const dddLocateDomainModelHandler: HandlerDef = {
  name: 'ddd_locate_domain_model',
  description: 'Find docs/DOMAIN-MODEL.md in a project root',
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

    // Verify root directory exists.
    try {
      execSync(`test -d ${quoteArg(root)}`, { encoding: 'utf8' });
    } catch {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: `root directory does not exist: ${root}`,
            }),
          },
        ],
      };
    }

    const modelPath = `${root}/docs/DOMAIN-MODEL.md`;
    try {
      execSync(`test -f ${quoteArg(modelPath)}`, { encoding: 'utf8' });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ ok: true, path: modelPath, exists: true }),
          },
        ],
      };
    } catch {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ ok: true, exists: false }),
          },
        ],
      };
    }
  },
};

export default dddLocateDomainModelHandler;
