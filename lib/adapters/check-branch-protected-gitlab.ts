/**
 * GitLab `checkBranchProtected` adapter implementation (#465).
 *
 * Sibling of `check-branch-protected-github.ts`. Delegates to the
 * `gitlabApiProtectedBranch()` wrapper (in `lib/gitlab-api.ts`) which LISTS
 * `glab api projects/:id/protected_branches` and matches the branch name
 * client-side against each entry's `name` — a wildcard-aware check so a branch
 * protected only by a glob rule (e.g. `release/0.0.1` under `release/*`) is
 * correctly reported as protected. A real API failure propagates out of the
 * wrapper and is bounded here into `{ok: false}` rather than being misreported
 * as "not protected".
 */

import { execSync } from 'child_process';
import { gitlabApiProtectedBranch } from '../gitlab-api.js';
import type {
  AdapterResult,
  CheckBranchProtectedArgs,
  CheckBranchProtectedResponse,
} from './types.js';

const GITLAB_REPO_SLUG = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)+$/;
const BRANCH_CHARSET = /^[A-Za-z0-9._\-/]+$/;

/** Split `owner/repo` (or nested `org/sub/repo`) into the opts shape the
 * gitlab-api wrapper expects; the wrapper rejoins + URL-encodes the whole
 * path, so a first-slash split preserves nested group depth. */
function parseSlugOpts(
  slug: string | undefined,
): { owner?: string; repo?: string } | undefined {
  if (slug === undefined) return undefined;
  const idx = slug.indexOf('/');
  if (idx <= 0 || idx === slug.length - 1) return undefined;
  return { owner: slug.slice(0, idx), repo: slug.slice(idx + 1) };
}

export async function checkBranchProtectedGitlab(
  args: CheckBranchProtectedArgs,
): Promise<AdapterResult<CheckBranchProtectedResponse>> {
  try {
    if (!BRANCH_CHARSET.test(args.branch)) {
      return {
        ok: false,
        code: 'invalid_branch',
        error: `checkBranchProtectedGitlab: invalid branch ${JSON.stringify(args.branch)}`,
      };
    }
    if (args.repo !== undefined && !GITLAB_REPO_SLUG.test(args.repo)) {
      return {
        ok: false,
        code: 'invalid_repo',
        error: `checkBranchProtectedGitlab: invalid repo slug ${JSON.stringify(args.repo)}`,
      };
    }

    const isProtected = gitlabApiProtectedBranch(
      args.branch,
      parseSlugOpts(args.repo),
      args.cwd,
    );
    return { ok: true, data: { protected: isProtected } };
  } catch (err) {
    return {
      ok: false,
      code: 'glab_protection_check_failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// `execSync` is intentionally re-imported above so that adapter-level test
// files can `mock.module('child_process', ...)` and intercept this module's
// subprocess calls.
void execSync;
