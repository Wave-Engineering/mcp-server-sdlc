// Origin Operations family handler — adapter-dispatching shell (#592).
// Subprocess + platform branching live in lib/adapters/pr-ready-{github,gitlab}.ts;
// the policy (the `precheck` pass) lives in lib/precheck-gate.ts.
//
// Marking a draft ready is how a PR/MR becomes mergeable on the precheck flow
// (claudecode-workflow#1235: draft first, CI runs, /precheck passes, then
// ready). It is gated exactly like a non-draft pr_create.

import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { getAdapter } from '../lib/adapters/index.js';
import { repoOptionalSchema } from '../lib/schemas/repo.js';
import { isExemptPr, prSnapshot, requirePrecheckPass } from '../lib/precheck-gate.js';

const inputSchema = z.object({
  number: z.number().int().positive('number must be a positive integer'),
  // GitLab nested groups need arbitrary `/` depth — see lib/schemas/repo.ts (#290).
  repo: repoOptionalSchema,
});

function envelope(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

const prReadyHandler: HandlerDef = {
  name: 'pr_ready',
  description:
    'Mark a draft PR (GitHub) / MR (GitLab) ready for review. Requires the `precheck` commit status = success on ' +
    'the PR/MR\'s own head SHA (run /precheck), except on integration pairs (head kahuna/* or campaign/*, or ' +
    'base kahuna/*). GitHub uses the GraphQL markPullRequestReadyForReview mutation; GitLab strips the draft ' +
    'prefix from the title (the draft state IS the title there). The PR/MR is read back to confirm. Returns ' +
    '{number, draft: false, head_sha, changed}; changed=false when it was already ready.',
  inputSchema,
  async execute(rawArgs: unknown) {
    let args;
    try {
      args = inputSchema.parse(rawArgs);
    } catch (err) {
      return envelope({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }

    const adapter = getAdapter({ repo: args.repo });
    const snap = await prSnapshot(adapter, args.number, args.repo, 'pr_ready');
    if (!snap.ok) return envelope({ ok: false, ...snap.refusal });
    if (snap.info.state !== 'open') {
      return envelope({ ok: false, code: 'pr_not_open', error: `pr_ready: PR/MR #${args.number} is ${snap.info.state}` });
    }
    if (!isExemptPr(snap.info)) {
      const refusal = await requirePrecheckPass(adapter, snap.info.head_sha, args.repo, 'pr_ready');
      if (refusal !== undefined) return envelope({ ok: false, ...refusal });
    }

    const result = await adapter.prReady(args);
    if ('platform_unsupported' in result) {
      return envelope({ ok: true, platform_unsupported: true, hint: result.hint });
    }
    if (!result.ok) return envelope({ ok: false, code: result.code, error: result.error });
    // A push between the check and the write leaves a ready PR/MR on a head
    // with no pass. pr_merge re-checks at merge time, so say so, don't hide it.
    const warnings =
      result.data.head_sha !== snap.info.head_sha
        ? [`the head moved from ${snap.info.head_sha.slice(0, 7)} to ${result.data.head_sha.slice(0, 7)} while marking ready; the new head has no precheck pass, and pr_merge will refuse it`]
        : [];
    return envelope({ ok: true, ...result.data, ...(warnings.length > 0 ? { warnings } : {}) });
  },
};

export default prReadyHandler;
