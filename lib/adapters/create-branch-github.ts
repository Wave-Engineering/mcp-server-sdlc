/**
 * GitHub `createBranch` adapter implementation.
 *
 * Lifted from `handlers/wave_init.ts`'s local `createKahunaBranch` helper per
 * Story 2.22 (#316). Creates a new branch ref pointing at an explicit SHA.
 *
 * Argv: `gh api repos/<slug>/git/refs -X POST -f ref=refs/heads/<branch>
 *        -f sha=<sha>`.
 *
 * `gh api` resolves repo context from the URL path — no `--repo` flag
 * (that belongs to porcelain subcommands like `gh pr …`). The slug must
 * match `owner/repo`; branch/sha are validated against narrow regexes.
 *
 * Returns `void` on success. There's no "already exists" idempotent path —
 * the handler's state/remote pre-check catches that case before the call.
 */

import { execSync } from 'child_process';
import { runArgv } from '../shared/error-norm.js';
import type { AdapterResult, CreateBranchArgs } from './types.js';

const GITHUB_REPO_SLUG = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const BRANCH_CHARSET = /^[A-Za-z0-9._\-/]+$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;

function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

export async function createBranchGithub(
  args: CreateBranchArgs,
): Promise<AdapterResult<void>> {
  try {
    if (!BRANCH_CHARSET.test(args.branch)) {
      return {
        ok: false,
        code: 'invalid_branch',
        error: `createBranchGithub: invalid branch ${JSON.stringify(args.branch)}`,
      };
    }
    if (!SHA_PATTERN.test(args.sha)) {
      return {
        ok: false,
        code: 'invalid_sha',
        error: `createBranchGithub: invalid sha ${JSON.stringify(args.sha)}`,
      };
    }
    if (args.repo !== undefined && !GITHUB_REPO_SLUG.test(args.repo)) {
      return {
        ok: false,
        code: 'invalid_repo',
        error: `createBranchGithub: invalid repo slug ${JSON.stringify(args.repo)}`,
      };
    }

    const slug = args.repo ?? ':owner/:repo';
    const cmd = [
      'gh',
      'api',
      `repos/${slug}/git/refs`,
      '-X',
      'POST',
      '-f',
      `ref=refs/heads/${args.branch}`,
      '-f',
      `sha=${args.sha}`,
    ];
    const result = runArgv(cmd, projectDir());
    if (result.exitCode !== 0) {
      return {
        ok: false,
        code: 'gh_create_branch_failed',
        error: `failed to create branch ${args.branch}: ${result.stderr.trim() || result.stdout.trim()}`,
      };
    }

    return { ok: true, data: undefined };
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
