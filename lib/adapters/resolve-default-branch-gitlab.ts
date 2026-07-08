/**
 * GitLab `resolveDefaultBranch` adapter implementation (#465).
 *
 * Sibling of `resolve-default-branch-github.ts` — promotes the private
 * `getDefaultBranch()` helper that `pr-create-gitlab.ts` carried into a shared
 * adapter method.
 *
 * Argv: `glab api projects/<encoded>` → `{ default_branch }`. Use `:id` as the
 * project segment when no slug is provided; `glab` resolves that from the cwd
 * remote. No `--jq` flag (glab 1.36.0 rejects it) — parse the JSON in-process.
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
 * Resolve the repo's default branch via `glab api projects/<encoded>`. Throws
 * on failure — the sync core used by `prCreateGitlab`.
 */
export function resolveDefaultBranchGitlabSync(
  repo: string | undefined,
  cwd: string,
): string {
  const project = repo !== undefined ? repo.replace(/\//g, '%2F') : ':id';
  const result = runArgv(['glab', 'api', `projects/${project}`], cwd);
  if (result.exitCode !== 0 || result.stdout.trim().length === 0) {
    throw new Error(
      `failed to resolve GitLab default branch: ${result.stderr.trim() || 'empty response'}`,
    );
  }
  const parsed = JSON.parse(result.stdout) as { default_branch?: string };
  if (typeof parsed.default_branch !== 'string' || parsed.default_branch.length === 0) {
    throw new Error('default_branch missing or empty in glab api response');
  }
  return parsed.default_branch;
}

export async function resolveDefaultBranchGitlab(
  args: ResolveDefaultBranchArgs,
): Promise<AdapterResult<ResolveDefaultBranchResponse>> {
  try {
    const cwd = args.cwd ?? projectDir();
    const default_branch = resolveDefaultBranchGitlabSync(args.repo, cwd);
    return { ok: true, data: { default_branch } };
  } catch (err) {
    return {
      ok: false,
      code: 'glab_default_branch_failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// `execSync` is intentionally re-imported above so that adapter-level test
// files can `mock.module('child_process', ...)` and intercept this module's
// subprocess calls.
void execSync;
