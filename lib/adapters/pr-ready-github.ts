/**
 * GitHub `prReady` adapter (#592): mark a draft PR ready for review.
 *
 * REST has no endpoint for it; this is the GraphQL
 * `markPullRequestReadyForReview` mutation, the one `gh pr ready` itself uses.
 * The PR is read back afterwards, and one still in draft is `ok: false`, so a
 * GraphQL error that exits 0 cannot read as success. Policy (the `precheck`
 * pass) is the caller's: lib/precheck-gate.ts.
 */

import { execSync } from 'child_process';
import { runArgv } from '../shared/error-norm.js';
import type { AdapterResult, PrReadyArgs, PrReadyResponse } from './types.js';
import { projectDir, viewPrGithub } from './precheck-shared-github.js';

const MUTATION =
  'mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { isDraft } } }';

export async function prReadyGithub(args: PrReadyArgs): Promise<AdapterResult<PrReadyResponse>> {
  try {
    const before = viewPrGithub(args.number, args.repo, 'pr_ready_failed');
    if (!before.ok) return before;
    if (!before.data.draft) {
      return { ok: true, data: { number: args.number, draft: false, head_sha: before.data.head_sha, changed: false } };
    }
    const cmd = ['gh', 'api', 'graphql', '-f', `query=${MUTATION}`, '-f', `id=${before.data.node_id}`];
    const result = runArgv(cmd, projectDir());
    if (result.exitCode !== 0) {
      return {
        ok: false,
        code: 'pr_ready_failed',
        error: `could not mark PR #${args.number} ready: ${result.stderr.trim() || result.stdout.trim()}`,
      };
    }
    const after = viewPrGithub(args.number, args.repo, 'pr_ready_failed');
    if (!after.ok) return after;
    if (after.data.draft) {
      return { ok: false, code: 'pr_ready_failed', error: `PR #${args.number} is still a draft after the ready mutation` };
    }
    return { ok: true, data: { number: args.number, draft: false, head_sha: after.data.head_sha, changed: true } };
  } catch (err) {
    return { ok: false, code: 'unexpected_error', error: err instanceof Error ? err.message : String(err) };
  }
}

void execSync;
