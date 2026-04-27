/**
 * GitHub `resolveBranchSha` adapter implementation — the `ci_wait_run`
 * branch→SHA sub-call (Story 2.19, #313).
 *
 * Lifted from `handlers/ci_wait_run.ts`'s local `resolveBranchToSha` helper.
 * Called by the polling loop ONLY when it needs to compare a branch ref
 * against a `run.headSha` (e.g., merge-queue Phase 0 pre-flight). When
 * `expected_sha` is provided — or the ref is already a SHA — the call is
 * skipped entirely.
 *
 * Returns `{sha}` on successful resolution; `null` when resolution fails for
 * any reason (missing repo, deleted branch, unauthenticated `gh`). The
 * caller treats a `null` data payload as "no SHA match" — same semantics as
 * the pre-migration helper's `try { … } catch { return null }`.
 *
 * Argv: `gh api repos/<slug>/git/refs/heads/<branch> --jq .object.sha`.
 */

import { execSync } from 'child_process';
import { runArgv } from '../shared/error-norm.js';
import type {
  AdapterResult,
  ResolveBranchShaArgs,
  ResolveBranchShaResponse,
} from './types.js';

const GITHUB_REPO_SLUG = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const BRANCH_CHARSET = /^[A-Za-z0-9._\-/]+$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;

function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

export async function resolveBranchShaGithub(
  args: ResolveBranchShaArgs,
): Promise<AdapterResult<ResolveBranchShaResponse | null>> {
  try {
    if (!BRANCH_CHARSET.test(args.branch)) {
      return {
        ok: false,
        code: 'invalid_branch',
        error: `resolveBranchShaGithub: invalid branch ${JSON.stringify(args.branch)}`,
      };
    }
    if (args.repo !== undefined && !GITHUB_REPO_SLUG.test(args.repo)) {
      return {
        ok: false,
        code: 'invalid_repo',
        error: `resolveBranchShaGithub: invalid repo slug ${JSON.stringify(args.repo)}`,
      };
    }

    const slug = args.repo;
    if (slug === undefined) {
      // No slug resolution is available at this layer — callers are expected
      // to pass an explicit slug (or resolve cwd via `parseRepoSlug()`
      // upstream). Surface `null` so the polling loop treats it as "no SHA
      // match" rather than exploding.
      return { ok: true, data: null };
    }

    const cmd = [
      'gh',
      'api',
      `repos/${slug}/git/refs/heads/${args.branch}`,
      '--jq',
      '.object.sha',
    ];
    const result = runArgv(cmd, projectDir());
    if (result.exitCode !== 0) {
      // Soft-fail: the pre-migration helper swallowed all errors and
      // returned null. Preserve that contract so "branch doesn't exist" /
      // "unauthenticated" collapses to "no SHA match" instead of an error.
      return { ok: true, data: null };
    }

    const sha = result.stdout.trim();
    if (!SHA_PATTERN.test(sha)) return { ok: true, data: null };
    return { ok: true, data: { sha } };
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
