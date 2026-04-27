/**
 * GitLab `resolveBranchSha` adapter implementation.
 *
 * Lifted from the pre-migration `handlers/wave_init.ts`'s local `getMainHeadSha`
 * helper per Story 2.22 (#316) — the original Story 2.19 (#313) landed this
 * method as a permanent `platform_unsupported` stub because `ci_wait_run`
 * doesn't need the resolution on GitLab (pipelines attach to branch names
 * directly). `wave_init`'s KAHUNA bootstrap, however, needs the HEAD SHA of
 * the plan's base branch to feed into `createBranch`, so this adapter gets a
 * real body.
 *
 * `ci-wait-run-poll.ts` treats `platform_unsupported` and `{data: null}` the
 * same way (soft-fail to null), so returning a real sha here stays backward
 * compatible with that consumer.
 *
 * Argv: `glab api projects/:id/repository/branches/<branch>` →
 * `{ commit: { id: <sha> } }`. The `:id` slug is `%2F`-encoded from
 * `owner/repo`.
 *
 * Returns `{sha}` on success; `null` when resolution fails for any reason
 * (missing repo slug, deleted branch, unauthenticated `glab`) — same
 * soft-fail contract as the GitHub adapter so the polling loop can collapse
 * both into "no SHA match".
 */

import { execSync } from 'child_process';
import { runArgv } from '../shared/error-norm.js';
import type {
  AdapterResult,
  ResolveBranchShaArgs,
  ResolveBranchShaResponse,
} from './types.js';

const GITLAB_REPO_SLUG = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)+$/;
const BRANCH_CHARSET = /^[A-Za-z0-9._\-/]+$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;

function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

export async function resolveBranchShaGitlab(
  args: ResolveBranchShaArgs,
): Promise<AdapterResult<ResolveBranchShaResponse | null>> {
  try {
    if (!BRANCH_CHARSET.test(args.branch)) {
      return {
        ok: false,
        code: 'invalid_branch',
        error: `resolveBranchShaGitlab: invalid branch ${JSON.stringify(args.branch)}`,
      };
    }
    if (args.repo !== undefined && !GITLAB_REPO_SLUG.test(args.repo)) {
      return {
        ok: false,
        code: 'invalid_repo',
        error: `resolveBranchShaGitlab: invalid repo slug ${JSON.stringify(args.repo)}`,
      };
    }

    const slug = args.repo;
    if (slug === undefined) {
      // No slug resolution is available at this layer — callers pass an
      // explicit slug (or resolve cwd via `parseRepoSlug()` upstream).
      return { ok: true, data: null };
    }

    const encoded = slug.replace(/\//g, '%2F');
    const cmd = [
      'glab',
      'api',
      `projects/${encoded}/repository/branches/${args.branch}`,
    ];
    const result = runArgv(cmd, projectDir());
    if (result.exitCode !== 0) {
      // Soft-fail to null — mirrors the GitHub adapter contract.
      return { ok: true, data: null };
    }

    try {
      const parsed = JSON.parse(result.stdout) as { commit?: { id?: string } };
      const sha = parsed.commit?.id;
      if (typeof sha !== 'string' || !SHA_PATTERN.test(sha)) {
        return { ok: true, data: null };
      }
      return { ok: true, data: { sha } };
    } catch {
      return { ok: true, data: null };
    }
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
