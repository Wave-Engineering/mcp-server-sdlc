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

const inputSchema = z.object({
  number: z.number().int().positive('number must be a positive integer'),
  squash_message: z.string().optional(),
  use_merge_queue: z.boolean().optional(),
  skip_train: z.boolean().optional(),
  repo: z
    .string()
    .regex(/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/, 'repo must be owner/repo format')
    .optional(),
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
    'Same input as pr_merge plus timeout_sec (default 600). Returns the same aggregate ' +
    'envelope as pr_merge with merged=true, pr_state="MERGED" guaranteed on success. ' +
    'Detects "already merged" and short-circuits without re-attempting the merge. ' +
    'Use this when downstream work needs the commit on main; use pr_merge when ' +
    'enrollment is enough.',
  inputSchema,
  async execute(rawArgs: unknown) {
    let args;
    try {
      args = inputSchema.parse(rawArgs);
    } catch (err) {
      return envelope({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }

    const result = await getAdapter({ repo: args.repo }).prMergeWait(args);
    if ('platform_unsupported' in result) {
      return envelope({ ok: true, platform_unsupported: true, hint: result.hint });
    }
    if (!result.ok) return envelope({ ok: false, error: result.error });
    return envelope({ ok: true, ...result.data });
  },
};

export default prMergeWaitHandler;
