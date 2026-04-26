// Origin Operations family handler — adapter-dispatching shell.
// Subprocess + platform branching live in lib/adapters/work-item-{github,gitlab}.ts
// per Story 2.17 (#311); see docs/handlers/origin-operations-guide.md for the
// canonical pattern and docs/platform-adapter-retrofit-devspec.md §5 for the
// contract.
//
// Closes #281: the pre-migration dispatch ran the wrong platform's create fn
// when `type:'pr'` hit a GitLab repo (or `type:'mr'` hit GitHub). The adapter
// boundary now returns `{platform_unsupported: true, hint: ...}` for those
// combinations, which the handler surfaces as a typed error envelope rather
// than silently running the wrong sub-command.

import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { getAdapter } from '../lib/adapters/index.js';

const inputSchema = z.object({
  type: z.enum(['epic', 'story', 'feature', 'bug', 'chore', 'docs', 'fix', 'pr', 'mr']),
  title: z.string().min(1, 'title must be a non-empty string'),
  body: z.string().optional(),
  labels: z.array(z.string()).optional(),
  head_branch: z.string().optional(),
  base_branch: z.string().optional(),
  draft: z.boolean().optional(),
  repo: z
    .string()
    .regex(/^[a-zA-Z0-9._/-]+\/[a-zA-Z0-9._-]+$/, 'repo must be owner/repo format')
    .optional(),
});

function envelope(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

const workItemHandler: HandlerDef = {
  name: 'work_item',
  description:
    'Create a GitHub issue/PR or GitLab issue/MR via the appropriate CLI. `type` drives dispatch; cross-platform types (pr on GitLab, mr on GitHub) return a typed platform_unsupported error.',
  inputSchema,
  async execute(rawArgs: unknown) {
    let args;
    try {
      args = inputSchema.parse(rawArgs);
    } catch (err) {
      return envelope({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }

    const adapter = getAdapter({ repo: args.repo });
    const result = await adapter.workItem(args);

    if ('platform_unsupported' in result) {
      return envelope({ ok: false, platform_unsupported: true, error: result.hint });
    }
    if (!result.ok) return envelope({ ok: false, error: result.error });
    return envelope({ ok: true, ...result.data });
  },
};

export default workItemHandler;
