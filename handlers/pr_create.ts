// Origin Operations family handler — adapter-dispatching shell.
// Subprocess + platform branching live in lib/adapters/pr-create-{github,gitlab}.ts;
// see docs/handlers/origin-operations-guide.md for the canonical pattern and
// docs/platform-adapter-retrofit-devspec.md §5 for the contract.

import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { getAdapter } from '../lib/adapters/index.js';

const inputSchema = z.object({
  title: z.string().min(1, 'title must be a non-empty string'),
  body: z.string().min(1, 'body must be a non-empty string'),
  // base is optional — when omitted, the adapter resolves the repo's
  // default branch so /scp + sibling skills don't need to probe it (#159).
  base: z.string().min(1).optional(),
  head: z.string().optional(),
  draft: z.boolean().optional().default(false),
  repo: z
    .string()
    .regex(/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/, 'repo must be owner/repo format')
    .optional(),
});

function envelope(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

const prCreateHandler: HandlerDef = {
  name: 'pr_create',
  description:
    'Create a pull request (GitHub) or merge request (GitLab) for the current branch. Returns the normalized {number, url, state, head, base}.',
  inputSchema,
  async execute(rawArgs: unknown) {
    let args;
    try {
      args = inputSchema.parse(rawArgs);
    } catch (err) {
      return envelope({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }

    const adapter = getAdapter({ repo: args.repo });
    const result = await adapter.prCreate(args);

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

export default prCreateHandler;
