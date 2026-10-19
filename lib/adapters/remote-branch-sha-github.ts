/**
 * GitHub `remoteBranchSha` adapter (#592): where a branch points on GitHub,
 * which is the commit a PR created from it opens with.
 *
 * Argv: `gh api repos/<slug>/git/ref/heads/<branch>`. The SINGULAR `ref`
 * endpoint is an exact match; the plural `refs` one prefix-matches and can
 * answer for a different branch.
 *
 * Unlike `resolveBranchSha` (which soft-fails to `null` for `ci_wait_run`),
 * this FAILS CLOSED: a branch that was never pushed, an API error, or an
 * unexpected body is `ok: false`.
 */

import { execSync } from 'child_process';
import { runArgv } from '../shared/error-norm.js';
import type { AdapterResult, RemoteBranchShaArgs, RemoteBranchShaResponse } from './types.js';
import { BRANCH_CHARSET, GITHUB_REPO_SLUG, SHA_PATTERN, githubSlugPath, projectDir } from './precheck-shared-github.js';

export async function remoteBranchShaGithub(
  args: RemoteBranchShaArgs,
): Promise<AdapterResult<RemoteBranchShaResponse>> {
  try {
    if (!BRANCH_CHARSET.test(args.branch)) {
      return { ok: false, code: 'invalid_branch', error: `remoteBranchShaGithub: invalid branch ${JSON.stringify(args.branch)}` };
    }
    if (args.repo !== undefined && !GITHUB_REPO_SLUG.test(args.repo)) {
      return { ok: false, code: 'invalid_repo', error: `remoteBranchShaGithub: invalid repo slug ${JSON.stringify(args.repo)}` };
    }
    const cmd = ['gh', 'api', `repos/${githubSlugPath(args.repo)}/git/ref/heads/${args.branch}`];
    const result = runArgv(cmd, projectDir());
    if (result.exitCode !== 0) {
      return {
        ok: false,
        code: 'remote_branch_read_failed',
        error: `could not read branch ${args.branch} on GitHub (is it pushed?): ${result.stderr.trim() || result.stdout.trim()}`,
      };
    }
    let sha: unknown;
    try {
      sha = (JSON.parse(result.stdout) as { object?: { sha?: unknown } } | null)?.object?.sha;
    } catch {
      sha = undefined;
    }
    if (typeof sha !== 'string' || !SHA_PATTERN.test(sha)) {
      return { ok: false, code: 'remote_branch_read_failed', error: `branch ${args.branch}: response carries no commit sha` };
    }
    return { ok: true, data: { sha } };
  } catch (err) {
    return { ok: false, code: 'unexpected_error', error: err instanceof Error ? err.message : String(err) };
  }
}

void execSync;
