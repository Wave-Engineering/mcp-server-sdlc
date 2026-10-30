// Origin Operations family handler — adapter-dispatching shell.
// Subprocess + platform branching live in lib/adapters/pr-merge-wait-{github,gitlab}.ts;
// the platform-agnostic polling loop lives in lib/pr-merge-wait-poll.ts so it
// isn't duplicated per platform. See docs/handlers/origin-operations-guide.md
// for the canonical pattern and docs/platform-adapter-retrofit-devspec.md §5
// for the contract.
//
// pr_merge_wait wraps pr_merge with a "block until commit lands on main" guarantee.
// Use this when downstream work (`git pull main`, post-merge CI checks) needs the
// merge to be observable. For "I just need to enroll the PR; I'll keep working,"
// stick with pr_merge.

import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { getAdapter } from '../lib/adapters/index.js';
import { repoOptionalSchema } from '../lib/schemas/repo.js';
import { confirmPin, mergeGate } from '../lib/precheck-gate.js';

const inputSchema = z.object({
  number: z.number().int().positive('number must be a positive integer'),
  squash_message: z.string().optional(),
  use_merge_queue: z.boolean().optional(),
  skip_train: z.boolean().optional(),
  // #474: caller-selected merge strategy, threaded through to the underlying
  // pr_merge. Default `squash` preserves prior behavior. Same queue caveat as
  // pr_merge — see this tool's description.
  merge_method: z.enum(['squash', 'merge', 'rebase']).default('squash'),
  // #611: the head the caller graded, with pr_merge's meaning (#609). Without it
  // zod would strip a caller's pin here silently, the failure the echo exposes.
  expected_head_sha: z
    .string()
    .regex(/^[0-9a-f]{40}$/, 'expected_head_sha must be a full 40-character lowercase hex SHA')
    .optional(),
  // GitLab nested groups need arbitrary `/` depth — see lib/schemas/repo.ts (#290).
  repo: repoOptionalSchema,
  timeout_sec: z
    .number()
    .int()
    .positive('timeout_sec must be a positive integer')
    .optional(),
});

function envelope(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

const prMergeWaitHandler: HandlerDef = {
  name: 'pr_merge_wait',
  description:
    'Merge a PR/MR and BLOCK until the commit is observable on main (or timeout). ' +
    'Same input as pr_merge (including merge_method: squash|merge|rebase, default squash) plus ' +
    'timeout_sec (default 600). Returns the same aggregate envelope as pr_merge with merged=true, ' +
    'pr_state="MERGED" guaranteed on success. Detects "already merged" and short-circuits without ' +
    're-attempting the merge. Use this when downstream work needs the commit on main; use pr_merge ' +
    'when enrollment is enough. merge_method is authoritative only on the immediate (non-queue) ' +
    'path; on a merge-queue-ENFORCED repo the queue\'s own configured method governs the merge. ' +
    'The same precheck gate as pr_merge applies (#592): outside integration pairs, squash only, a valid ' +
    '`## Squash commit` block in the body (which IS the squash commit), and `precheck` = success on the head, ' +
    'with the merge pinned to that head. An already-merged PR/MR is not gated. ' +
    'expected_head_sha has pr_merge\'s meaning: it pins an integration pair\'s merge, and on a gated merge a ' +
    'different one refuses with head_moved. pinned_head_sha (#611) follows pr_merge\'s rule, and is absent when ' +
    'the PR/MR was already merged and no merge ran.',
  inputSchema,
  async execute(rawArgs: unknown) {
    let args;
    try {
      args = inputSchema.parse(rawArgs);
    } catch (err) {
      return envelope({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }

    const adapter = getAdapter({ repo: args.repo });
    const gate = await mergeGate(adapter, args, 'pr_merge_wait');
    if (gate.kind === 'refused') return envelope({ ok: false, ...gate.refusal });
    const waitArgs =
      gate.kind === 'gated'
        ? {
            ...args,
            squash_subject: gate.commit.subject,
            squash_message: gate.commit.body,
            expected_head_sha: gate.head_sha,
          }
        : args;
    const result = await adapter.prMergeWait(waitArgs);
    if ('platform_unsupported' in result) {
      return envelope({ ok: true, platform_unsupported: true, hint: result.hint });
    }
    if (!result.ok) return envelope({ ok: false, code: result.code, error: result.error });
    // #611: the same pin echo as pr_merge. merge_skipped is internal: it says the
    // executor found the PR/MR merged since the gate read it, and ran no merge.
    const { merge_skipped, ...data } = result.data;
    const pin = await confirmPin(
      adapter,
      gate,
      waitArgs.expected_head_sha,
      { enrolled: data.enrolled, merge_skipped },
      args,
      'pr_merge_wait',
    );
    return envelope({
      ok: true,
      ...data,
      warnings: pin.warning !== undefined ? [...data.warnings, pin.warning] : data.warnings,
      ...(pin.pinned !== undefined ? { pinned_head_sha: pin.pinned } : {}),
    });
  },
};

export default prMergeWaitHandler;
