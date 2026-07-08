/**
 * GitHub `checkBranchProtected` adapter implementation (#465).
 *
 * The genuinely-new host query behind `branch_guard`: is a branch protected on
 * GitHub? Generalizes the hardcoded-`main` branch-protection call in
 * `fetch-ci-trust-signal-github.ts` to an arbitrary branch.
 *
 * Argv: `gh api repos/<slug>/branches/<branch>/protection`.
 *  - HTTP 200 ⇒ the branch is protected.
 *  - HTTP 404 ⇒ the branch is not protected (or has no protection rule).
 *
 * When no slug is provided the `{owner}/{repo}` placeholders resolve the repo
 * from the cwd remote (a documented `gh api` feature). A non-404 failure
 * (auth, network) surfaces as `{ok: false}` rather than being misreported as
 * "not protected" — a false "unprotected" would silently downgrade the guard
 * to `pass`.
 */

import { execSync } from 'child_process';
import { runArgv } from '../shared/error-norm.js';
import type {
  AdapterResult,
  CheckBranchProtectedArgs,
  CheckBranchProtectedResponse,
} from './types.js';

const GITHUB_REPO_SLUG = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const BRANCH_CHARSET = /^[A-Za-z0-9._\-/]+$/;

function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

export async function checkBranchProtectedGithub(
  args: CheckBranchProtectedArgs,
): Promise<AdapterResult<CheckBranchProtectedResponse>> {
  try {
    if (!BRANCH_CHARSET.test(args.branch)) {
      return {
        ok: false,
        code: 'invalid_branch',
        error: `checkBranchProtectedGithub: invalid branch ${JSON.stringify(args.branch)}`,
      };
    }
    if (args.repo !== undefined && !GITHUB_REPO_SLUG.test(args.repo)) {
      return {
        ok: false,
        code: 'invalid_repo',
        error: `checkBranchProtectedGithub: invalid repo slug ${JSON.stringify(args.repo)}`,
      };
    }

    const slug = args.repo ?? '{owner}/{repo}';
    const cmd = ['gh', 'api', `repos/${slug}/branches/${args.branch}/protection`];
    const result = runArgv(cmd, args.cwd ?? projectDir());

    if (result.exitCode === 0) {
      return { ok: true, data: { protected: true } };
    }

    // 404 (incl. "Branch not protected") ⇒ not protected. Any other failure
    // (auth, network) must NOT collapse to "unprotected".
    const combined = `${result.stderr}\n${result.stdout}`.toLowerCase();
    if (/404|not protected|not found/.test(combined)) {
      return { ok: true, data: { protected: false } };
    }
    return {
      ok: false,
      code: 'gh_protection_check_failed',
      error: `gh api branch protection failed: ${result.stderr.trim() || result.stdout.trim()}`,
    };
  } catch (err) {
    return {
      ok: false,
      code: 'unexpected_error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// `execSync` is intentionally re-imported above so that adapter-level test
// files can `mock.module('child_process', ...)` and intercept this module's
// subprocess calls.
void execSync;
