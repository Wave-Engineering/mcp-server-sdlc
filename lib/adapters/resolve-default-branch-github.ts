/**
 * GitHub `resolveDefaultBranch` adapter implementation (#465).
 *
 * Promotes the private `getDefaultBranch()` helper that `pr-create-github.ts`
 * carried into a shared adapter method so `branch_guard` and `pr_create` read
 * the live default branch from one place instead of two copies.
 *
 * Argv: `gh repo view [<slug>] --json defaultBranchRef --jq .defaultBranchRef.name`.
 * `gh repo view` resolves the repo from the cwd remote when no slug is given.
 *
 * `resolveDefaultBranchGithubSync` is the throwing core (kept for the sync
 * call-site inside `prCreateGithub`); the async `resolveDefaultBranchGithub`
 * wraps it into the `AdapterResult` contract so adapter callers never
 * try/catch.
 */

import { execSync } from 'child_process';
import { runArgv } from '../shared/error-norm.js';
import type {
  AdapterResult,
  ResolveDefaultBranchArgs,
  ResolveDefaultBranchResponse,
} from './types.js';

function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

/**
 * Resolve the repo's default branch via `gh repo view`. Throws on failure —
 * the sync core used by `prCreateGithub` (which already runs inside a
 * try/catch that bounds the throw into an `AdapterResult`).
 */
export function resolveDefaultBranchGithubSync(
  repo: string | undefined,
  cwd: string,
): string {
  const cmd = ['gh', 'repo', 'view'];
  if (repo !== undefined) cmd.push(repo);
  cmd.push('--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name');
  const result = runArgv(cmd, cwd);
  if (result.exitCode !== 0 || result.stdout.trim().length === 0) {
    throw new Error(
      `failed to resolve GitHub default branch: ${result.stderr.trim() || 'empty response'}`,
    );
  }
  return result.stdout.trim();
}

export async function resolveDefaultBranchGithub(
  args: ResolveDefaultBranchArgs,
): Promise<AdapterResult<ResolveDefaultBranchResponse>> {
  try {
    const cwd = args.cwd ?? projectDir();
    const default_branch = resolveDefaultBranchGithubSync(args.repo, cwd);
    return { ok: true, data: { default_branch } };
  } catch (err) {
    return {
      ok: false,
      code: 'gh_default_branch_failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// `execSync` is intentionally re-imported above so that adapter-level test
// files can `mock.module('child_process', ...)` and intercept this module's
// subprocess calls.
void execSync;
