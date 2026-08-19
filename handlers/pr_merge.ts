// Origin Operations family handler — adapter-dispatching shell.
// Subprocess + platform branching live in lib/adapters/pr-merge-{github,gitlab}.ts;
// see docs/platform-adapter-retrofit-devspec.md §5 for the contract.
//
// GitLab `skip_train: true` is silently dropped with a warning (#423) — merge
// trains are auto-managed at the project level, so there is no typed refusal
// to surface. (Superseded R-03 note: an earlier revision had the GitLab
// adapter return `{platform_unsupported, hint}` here; that shape was replaced
// by #423 and no longer exists in lib/adapters/pr-merge-gitlab.ts.)

import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { getAdapter } from '../lib/adapters/index.js';
import { repoOptionalSchema } from '../lib/schemas/repo.js';
import { emitStateEvent, scopeRoot } from '../lib/flightdeck_emit.js';

const inputSchema = z.object({
  number: z.number().int().positive('number must be a positive integer'),
  squash_message: z.string().optional(),
  use_merge_queue: z.boolean().optional(),
  skip_train: z.boolean().optional(),
  // GitLab nested groups need arbitrary `/` depth — see lib/schemas/repo.ts (#290).
  repo: repoOptionalSchema,
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
    'on main). On GitLab, a merge blocked by a non-transient gate (unmet approvals, unresolved ' +
    'discussions, draft status) returns enrolled=false with the blocker named in warnings — this is ' +
    'NOT enrollment, nothing is in progress, do not poll it (see #461). ' +
    'For "block until commit lands on main", use pr_merge_wait. ' +
    'skip_train=true bypasses the queue when commutativity_verify has proven the merge safe, except ' +
    'on queue-enforced repos where the flag is silently dropped (warning emitted). On GitLab, ' +
    'skip_train is silently dropped (merge trains are auto-managed) with a warning emitted — ' +
    'proceeds with the merge, does not return platform_unsupported.',
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
    // #424: the code is not decoration — a caller must be able to tell
    // "the merge command succeeded but state confirmation failed"
    // (gitlab_mr_state_fetch_failed) from "the merge genuinely failed"
    // (glab_mr_merge_failed) without string-matching the error text, per the
    // adapter's own documented contract (docs/adapters/README.md).
    if (!result.ok) return envelope({ ok: false, code: result.code, error: result.error });
    // FlightDeck emit (S1.5, additive) — a promote step for the merge, plus a
    // coded gate-override concern when skip_train bypassed the merge-train gate
    // (only meaningful when the queue was NOT enforced; enforced repos silently
    // drop the flag, surfaced in warnings). Fire-and-forget; response unchanged.
    // Scope to the handler's explicit repo (else a guarded project dir) so scope
    // resolution can't throw outside the emit guard.
    const root = scopeRoot(args.repo);
    const data = result.data;
    emitStateEvent(root, 'step', {
      action: 'promote',
      label: 'pr_merge',
      detail: { number: args.number, merged: data.merged, enrolled: data.enrolled },
    });
    if (args.skip_train) {
      emitStateEvent(root, 'concern', {
        concernKind: 'gate-override',
        source: 'coded',
        label: 'skip_train merge-queue bypass',
        detail: { number: args.number, merged: data.merged },
      });
    }
    return envelope({ ok: true, ...result.data });
  },
};

export default prMergeHandler;
