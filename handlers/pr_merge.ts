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
import { confirmPin, mergeGate } from '../lib/precheck-gate.js';

const inputSchema = z.object({
  number: z.number().int().positive('number must be a positive integer'),
  squash_message: z.string().optional(),
  use_merge_queue: z.boolean().optional(),
  skip_train: z.boolean().optional(),
  // #474: caller-selected merge strategy. Default `squash` preserves the prior
  // hardcoded behavior (no change for existing callers). `squash_message` is
  // applied to the squash/merge commit and ignored for `rebase`.
  merge_method: z.enum(['squash', 'merge', 'rebase']).default('squash'),
  // #609: the head the caller graded. On an integration pair it pins the merge
  // (GitHub --match-head-commit, GitLab --sha); on a gated merge the gate's
  // head stays authoritative and a different one refuses with head_moved.
  expected_head_sha: z
    .string()
    .regex(/^[0-9a-f]{40}$/, 'expected_head_sha must be a full 40-character lowercase hex SHA')
    .optional(),
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
    'proceeds with the merge, does not return platform_unsupported. ' +
    'merge_method (squash|merge|rebase, default squash) selects the strategy; it is authoritative ' +
    'ONLY on the immediate (non-queue / skip_train) path and reported back as merge_method:' +
    '"direct_squash"|"direct_merge"|"direct_rebase". On a merge-queue-ENFORCED repo the QUEUE\'s ' +
    'own configured merge method governs the enrolled PR — merge_method does NOT override it, and ' +
    'the response reports merge_method:"merge_queue". squash_message is ignored when merge_method=rebase. ' +
    'THE PRECHECK GATE (#592): outside integration pairs (head kahuna/* or campaign/*, or base kahuna/*) the ' +
    'merge must be a squash, the PR/MR body must carry a valid `## Squash commit` block (pr_create writes it), ' +
    'and the head SHA must carry `precheck` = success. The block IS the squash commit, subject and body; a ' +
    'squash_message that differs from it is refused (omit squash_message, or edit the block). The merge is ' +
    'pinned to the head the pass was checked on, so a push after review refuses with head_moved. ' +
    'expected_head_sha (optional, 40 lowercase hex) is the head the caller graded: on an integration pair ' +
    'the merge is pinned to it (GitHub --match-head-commit, GitLab --sha), so a head that moved since ' +
    'refuses rather than merging ungraded code; on a gated merge the gate\'s head stays authoritative and ' +
    'a different expected_head_sha refuses with head_moved before any merge is attempted. Omitted, nothing changes. ' +
    'pinned_head_sha (#611) in the response is the head this call pinned the merge (or queue enrollment) of an ' +
    'OPEN PR/MR to, confirmed by reading the head again after the call: the gate\'s head on a gated merge, the ' +
    'caller\'s expected_head_sha on an integration pair. It is NOT a merge signal: a queue enrollment carries it ' +
    'with merged=false, so require merged=true as well (or use pr_merge_wait). It is absent on an unpinned ' +
    'merge, on enrolled=false, on an already-merged/closed PR/MR, and when the head after the call differs ' +
    '(a warning names it). Callers that need the pin should require it: a server older than v5.1.0 drops ' +
    'expected_head_sha silently and merges unpinned, and v5.1.x pins but returns no pinned_head_sha.',
  inputSchema,
  async execute(rawArgs: unknown) {
    let args;
    try {
      args = inputSchema.parse(rawArgs);
    } catch (err) {
      return envelope({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }

    const adapter = getAdapter({ repo: args.repo });
    const gate = await mergeGate(adapter, args, 'pr_merge');
    if (gate.kind === 'refused') return envelope({ ok: false, ...gate.refusal });
    // An ungated merge (an integration pair) keeps the caller's expected_head_sha
    // (#609) in `args`, so the adapter pins it; a gated merge pins the gate's head.
    const mergeArgs =
      gate.kind === 'gated'
        ? {
            ...args,
            squash_subject: gate.commit.subject,
            squash_message: gate.commit.body,
            expected_head_sha: gate.head_sha,
          }
        : args;
    const result = await adapter.prMerge(mergeArgs);
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
    // #611: echo the pin, so a caller can require it. A server older than v5.1.0
    // strips an unknown expected_head_sha and merges unpinned, silently.
    const pin = await confirmPin(adapter, gate, mergeArgs.expected_head_sha, data, args, 'pr_merge');
    return envelope({
      ok: true,
      ...data,
      warnings: pin.warning !== undefined ? [...data.warnings, pin.warning] : data.warnings,
      ...(pin.pinned !== undefined ? { pinned_head_sha: pin.pinned } : {}),
    });
  },
};

export default prMergeHandler;
