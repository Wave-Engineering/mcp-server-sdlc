/**
 * GitLab `remoteBranchSha` adapter (#592): where a branch points on GitLab,
 * which is the commit an MR created from it opens with.
 *
 * Argv: `glab api projects/<id>/repository/branches/<url-encoded branch>`.
 * FAILS CLOSED, unlike `resolveBranchSha`: a branch that was never pushed, an
 * error body, or a response with no `commit.id` is `ok: false`.
 */

import { execSync } from 'child_process';
import type { AdapterResult, RemoteBranchShaArgs, RemoteBranchShaResponse } from './types.js';
import { BRANCH_CHARSET, GITLAB_REPO_SLUG, SHA_PATTERN, gitlabProject, glabApiJson } from './precheck-shared-gitlab.js';

export async function remoteBranchShaGitlab(
  args: RemoteBranchShaArgs,
): Promise<AdapterResult<RemoteBranchShaResponse>> {
  try {
    if (!BRANCH_CHARSET.test(args.branch)) {
      return { ok: false, code: 'invalid_branch', error: `remoteBranchShaGitlab: invalid branch ${JSON.stringify(args.branch)}` };
    }
    if (args.repo !== undefined && !GITLAB_REPO_SLUG.test(args.repo)) {
      return { ok: false, code: 'invalid_repo', error: `remoteBranchShaGitlab: invalid repo slug ${JSON.stringify(args.repo)}` };
    }
    const read = glabApiJson(
      [`projects/${gitlabProject(args.repo)}/repository/branches/${encodeURIComponent(args.branch)}`],
      'remote_branch_read_failed',
      `branch ${args.branch} on GitLab (is it pushed?)`,
    );
    if (!read.ok) return read;
    const sha = (read.data as { commit?: { id?: unknown } } | null)?.commit?.id;
    if (typeof sha !== 'string' || !SHA_PATTERN.test(sha)) {
      return { ok: false, code: 'remote_branch_read_failed', error: `branch ${args.branch}: response carries no commit sha` };
    }
    return { ok: true, data: { sha } };
  } catch (err) {
    return { ok: false, code: 'unexpected_error', error: err instanceof Error ? err.message : String(err) };
  }
}

void execSync;
