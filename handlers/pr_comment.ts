// Origin Operations family handler — adapter-dispatching shell.
// Subprocess + platform branching live in lib/adapters/pr-comment-{github,gitlab}.ts;
// see docs/handlers/origin-operations-guide.md for the canonical pattern and
// docs/platform-adapter-retrofit-devspec.md §5 for the contract.

import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { getAdapter } from '../lib/adapters/index.js';
import { repoOptionalSchema } from '../lib/schemas/repo.js';

const inputSchema = z.object({
  number: z.number().int().positive('number must be a positive integer'),
  body: z.string().min(1, 'body must be a non-empty string'),
  // GitLab nested groups need arbitrary `/` depth — see lib/schemas/repo.ts (#290).
  repo: repoOptionalSchema,
  // On GitLab, issues and MRs have separate number namespaces. Default 'mr'
  // for backwards compat; callers targeting issues must pass 'issue'. On
  // GitHub this is ignored (issues and PRs share a number space).
  target: z.enum(['issue', 'mr']).optional(),
});

function envelope(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

const prCommentHandler: HandlerDef = {
  name: 'pr_comment',
  description:
    'Post a top-level comment on a PR/MR or issue. On GitLab, pass target:"issue" to comment on issue #N (default targets MR !N). On GitHub, target is ignored.',
  inputSchema,
  async execute(rawArgs: unknown) {
    let args;
    try {
      args = inputSchema.parse(rawArgs);
    } catch (err) {
      return envelope({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }

    const adapter = getAdapter({ repo: args.repo });
    const result = await adapter.prComment(args);

    // Per dev spec §4.4 step 4: surface `platform_unsupported` as a typed
    // signal alongside `ok: true` — NOT as an error. The dispatch succeeded;
    // the platform just doesn't have the concept. Callers branch on the
    // discriminator instead of confusing it with a runtime failure.
    if ('platform_unsupported' in result) {
      return envelope({ ok: true, platform_unsupported: true, hint: result.hint });
    }
    if (!result.ok) return envelope({ ok: false, code: result.code, error: result.error });
    return envelope({ ok: true, ...result.data });
  },
};

export default prCommentHandler;
