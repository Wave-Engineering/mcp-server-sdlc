/**
 * GitHub `checkBranchProtected` adapter implementation (#465).
 *
 * The genuinely-new host query behind `branch_guard`: is a branch protected on
 * GitHub? Two sources, because neither alone is complete:
 *
 *   1. Classic / exact-name branch protection —
 *      `gh api repos/<slug>/branches/<branch>/protection` (200 ⇒ protected,
 *      404 ⇒ no classic protection). This is the endpoint
 *      `fetch-ci-trust-signal-github.ts` hardcoded to `main`.
 *   2. Repository rulesets (fallback when classic 404s) —
 *      `gh api repos/<slug>/rules/branches/<branch>`, the effective-rules-for-a-
 *      branch endpoint that returns rules from ALL rulesets applying to the
 *      branch, including WILDCARD rules like `release/*`. A NON-EMPTY array ⇒
 *      protected; `[]` ⇒ genuinely unprotected.
 *
 * `protected = (classic == 200) OR (rules/branches/<branch> is a non-empty
 * array)`. Checking classic alone missed a branch protected only by a wildcard
 * ruleset (e.g. an LTS `release/0.0.1` guarded by `release/*`) — the exact
 * scenario this guard exists to catch.
 *
 * When no slug is provided the `{owner}/{repo}` placeholders resolve the repo
 * from the cwd remote (a documented `gh api` feature). A NON-404 failure
 * (auth, network) surfaces as `{ok: false}` rather than being misreported as
 * "not protected" — a false "unprotected" would silently downgrade the guard
 * to `pass`.
 */

import { execSync } from 'child_process';
import { runArgv, type RunResult } from '../shared/error-norm.js';
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

/** A 404 / "not found" / "not protected" response — distinct from a real
 * (auth/network) failure, which must NOT collapse to "unprotected". */
function isNotFound(result: RunResult): boolean {
  const combined = `${result.stderr}\n${result.stdout}`.toLowerCase();
  return /404|not protected|not found/.test(combined);
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
    const cwd = args.cwd ?? projectDir();

    // (1) Classic / exact-name branch protection.
    const classic = runArgv(
      ['gh', 'api', `repos/${slug}/branches/${args.branch}/protection`],
      cwd,
    );
    if (classic.exitCode === 0) {
      return { ok: true, data: { protected: true } };
    }
    if (!isNotFound(classic)) {
      return {
        ok: false,
        code: 'gh_protection_check_failed',
        error: `gh api branch protection failed: ${classic.stderr.trim() || classic.stdout.trim()}`,
      };
    }

    // (2) No classic protection → fall back to the effective rulesets for this
    //     branch. Covers wildcard/ruleset protection the exact-name endpoint
    //     404s on.
    const rules = runArgv(
      ['gh', 'api', `repos/${slug}/rules/branches/${args.branch}`],
      cwd,
    );
    if (rules.exitCode === 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rules.stdout);
      } catch {
        parsed = null;
      }
      const protectedByRules = Array.isArray(parsed) && parsed.length > 0;
      return { ok: true, data: { protected: protectedByRules } };
    }
    // No rules apply (endpoint reports the branch as ruleless) → not protected.
    if (isNotFound(rules)) {
      return { ok: true, data: { protected: false } };
    }
    return {
      ok: false,
      code: 'gh_protection_check_failed',
      error: `gh api branch rules failed: ${rules.stderr.trim() || rules.stdout.trim()}`,
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
