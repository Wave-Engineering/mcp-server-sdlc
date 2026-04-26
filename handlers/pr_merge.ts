// Origin Operations family handler — adapter-dispatching shell.
// Subprocess + platform branching live in lib/adapters/pr-merge-{github,gitlab}.ts;
// see docs/platform-adapter-retrofit-devspec.md §5 for the contract.
//
// **R-03 typed-asymmetry exemplar.** GitLab adapter returns
// `{platform_unsupported, hint}` for `skip_train: true`; this handler surfaces
// it as `{ok: true, platform_unsupported: true, hint}` per Dev Spec §4.4 step 4.

import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { getAdapter } from '../lib/adapters/index.js';

const inputSchema = z.object({
  number: z.number().int().positive('number must be a positive integer'),
  squash_message: z.string().optional(),
  use_merge_queue: z.boolean().optional(),
  skip_train: z.boolean().optional(),
  repo: z
    .string()
    .regex(/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/, 'repo must be owner/repo format')
    .optional(),
});

function envelope(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

const prMergeHandler: HandlerDef = {
  name: 'pr_merge',
  description:
    'Merge a PR/MR with squash + delete source branch. Returns the AGGREGATE state — ' +
    '{enrolled, merged, merge_method, queue:{enabled,position,enforced}, pr_state, warnings} — ' +
    'so the caller decides what "merged" means for their use case. On a merge-queue-enforced repo ' +
    'the response is eager: enrolled=true, merged=false, pr_state="OPEN" (the PR is queued, not yet ' +
    'on main). For "block until commit lands on main", use pr_merge_wait. ' +
    'skip_train=true bypasses the queue when commutativity_verify has proven the merge safe, except ' +
    'on queue-enforced repos where the flag is silently dropped (warning emitted). On GitLab, ' +
    'skip_train returns {platform_unsupported: true, hint} — merge trains are auto-managed.',
  inputSchema,
  async execute(rawArgs: unknown) {
    let args;
    try {
      args = inputSchema.parse(rawArgs);
    } catch (err) {
      return envelope({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }

    const result = await getAdapter({ repo: args.repo }).prMerge(args);
    // Per dev spec §4.4 step 4: surface `platform_unsupported` as a typed
    // signal alongside `ok: true` — callers branch on the discriminator
    // instead of being lied to with a fake "merged: true".
    if ('platform_unsupported' in result) {
      return envelope({ ok: true, platform_unsupported: true, hint: result.hint });
    }
    if (!result.ok) return envelope({ ok: false, error: result.error });
    return envelope({ ok: true, ...result.data });
  },
};

export default prMergeHandler;
