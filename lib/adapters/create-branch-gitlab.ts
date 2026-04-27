/**
 * GitLab `createBranch` adapter implementation.
 *
 * Lifted from `handlers/wave_init.ts`'s local `createKahunaBranch` helper per
 * Story 2.22 (#316). Mirrors `create-branch-github.ts` — the handler dispatches
 * to either depending on cwd platform.
 *
 * Argv: `glab api projects/<encoded>/repository/branches -X POST
 *        -f branch=<name> -f ref=<sha>`.
 *
 * The `:id` slug is `%2F`-encoded from `owner/repo`. `glab api` resolves repo
 * context from the URL path — no `-R <slug>` flag (that belongs to porcelain
 * subcommands).
 *
 * Returns `void` on success. There's no "already exists" idempotent path —
 * the handler's state/remote pre-check catches that case before the call.
 */

import { execSync } from 'child_process';
import { runArgv } from '../shared/error-norm.js';
import type { AdapterResult, CreateBranchArgs } from './types.js';

const GITLAB_REPO_SLUG = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)+$/;
const BRANCH_CHARSET = /^[A-Za-z0-9._\-/]+$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;

function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

export async function createBranchGitlab(
  args: CreateBranchArgs,
): Promise<AdapterResult<void>> {
  try {
    if (!BRANCH_CHARSET.test(args.branch)) {
      return {
        ok: false,
        code: 'invalid_branch',
        error: `createBranchGitlab: invalid branch ${JSON.stringify(args.branch)}`,
      };
    }
    if (!SHA_PATTERN.test(args.sha)) {
      return {
        ok: false,
        code: 'invalid_sha',
        error: `createBranchGitlab: invalid sha ${JSON.stringify(args.sha)}`,
      };
    }
    if (args.repo !== undefined && !GITLAB_REPO_SLUG.test(args.repo)) {
      return {
        ok: false,
        code: 'invalid_repo',
        error: `createBranchGitlab: invalid repo slug ${JSON.stringify(args.repo)}`,
      };
    }

    const encoded = (args.repo ?? '').replace(/\//g, '%2F');
    const cmd = [
      'glab',
      'api',
      `projects/${encoded}/repository/branches`,
      '-X',
      'POST',
      '-f',
      `branch=${args.branch}`,
      '-f',
      `ref=${args.sha}`,
    ];
    const result = runArgv(cmd, projectDir());
    if (result.exitCode !== 0) {
      return {
        ok: false,
        code: 'glab_create_branch_failed',
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
