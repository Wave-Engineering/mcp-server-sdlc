/**
 * Shared bits of the GitHub `precheck` gate adapters (#592): input patterns,
 * the project directory, the repo path, and the one `gh pr view` read that
 * `prPrecheckInfo` and `prReady` both need.
 */

import { runArgv } from '../shared/error-norm.js';
import type { PrPrecheckInfo } from './types.js';

/** An `AdapterResult` without `platform_unsupported`: these reads always run. */
export type ReadResult<T> = { ok: true; data: T } | { ok: false; error: string; code: string };

export const GITHUB_REPO_SLUG = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
export const BRANCH_CHARSET = /^[A-Za-z0-9._\-/]+$/;
export const SHA_PATTERN = /^[0-9a-f]{40}$/i;

export function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

/** `owner/repo` for `gh api`; gh's own placeholder (resolved from cwd) when omitted. */
export function githubSlugPath(repo: string | undefined): string {
  return repo ?? '{owner}/{repo}';
}

/** A PR as `gh pr view --json` reports it, plus its GraphQL node id. */
export interface GithubPrView extends PrPrecheckInfo {
  node_id: string;
}

const VIEW_FIELDS = 'id,headRefOid,headRefName,baseRefName,title,body,isDraft,state,isCrossRepository';

export function viewPrGithub(number: number, repo: string | undefined, code: string): ReadResult<GithubPrView> {
  if (repo !== undefined && !GITHUB_REPO_SLUG.test(repo)) {
    return { ok: false, code: 'invalid_repo', error: `invalid repo slug ${JSON.stringify(repo)}` };
  }
  const cmd = ['gh', 'pr', 'view', String(number), '--json', VIEW_FIELDS];
  if (repo !== undefined) cmd.push('--repo', repo);
  const result = runArgv(cmd, projectDir());
  if (result.exitCode !== 0) {
    return { ok: false, code, error: `could not read PR #${number}: ${result.stderr.trim() || result.stdout.trim()}` };
  }
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    return { ok: false, code, error: `PR #${number}: unparseable gh pr view output` };
  }
  const sha = v.headRefOid;
  if (typeof sha !== 'string' || !SHA_PATTERN.test(sha) || typeof v.isDraft !== 'boolean' || typeof v.id !== 'string') {
    return { ok: false, code, error: `PR #${number}: gh pr view output lacks headRefOid/isDraft/id` };
  }
  const state = v.state === 'MERGED' ? 'merged' : v.state === 'CLOSED' ? 'closed' : 'open';
  return {
    ok: true,
    data: {
      node_id: v.id,
      head_sha: sha,
      head_ref: typeof v.headRefName === 'string' ? v.headRefName : '',
      base_ref: typeof v.baseRefName === 'string' ? v.baseRefName : '',
      title: typeof v.title === 'string' ? v.title : '',
      body: typeof v.body === 'string' ? v.body : '',
      draft: v.isDraft,
      state,
      same_repo: v.isCrossRepository === false,
    },
  };
}
