// Origin Operations family handler — adapter-dispatching shell.
// Subprocess + platform branching live in lib/adapters/pr-list-{github,gitlab}.ts;
// see docs/handlers/origin-operations-guide.md for the canonical pattern and
// docs/platform-adapter-retrofit-devspec.md §5 for the contract.

import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { getAdapter } from '../lib/adapters/index.js';

const inputSchema = z.object({
  head: z.string().optional(),
  base: z.string().optional(),
  state: z.enum(['open', 'closed', 'merged', 'all']).optional().default('open'),
  author: z.string().optional(),
  limit: z.number().int().positive().optional().default(20),
  repo: z
    .string()
    .regex(/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/, 'repo must be owner/repo format')
    .optional(),
});

function envelope(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

const prListHandler: HandlerDef = {
  name: 'pr_list',
  description:
    'List PRs (GitHub) or MRs (GitLab) filtered by head branch, base branch, state, and author. Used to check whether a PR already exists for the current branch before creating a new one.',
  inputSchema,
  async execute(rawArgs: unknown) {
    let args;
    try {
      args = inputSchema.parse(rawArgs);
    } catch (err) {
      return envelope({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }

    const adapter = getAdapter({ repo: args.repo });
    const result = await adapter.prList(args);

    // Per dev spec §4.4 step 4: surface `platform_unsupported` as a typed
    // signal alongside `ok: true` — NOT as an error. The dispatch succeeded;
    // the platform just doesn't have the concept. Callers branch on the
    // discriminator instead of confusing it with a runtime failure.
    if ('platform_unsupported' in result) {
      return envelope({ ok: true, platform_unsupported: true, hint: result.hint });
    }
    if (!result.ok) return envelope({ ok: false, error: result.error });
    return envelope({ ok: true, ...result.data });
  },
};

export default prListHandler;
