/**
 * Shared bits of the GitLab `precheck` gate adapters (#592): the project path,
 * one fail-closed `glab api` JSON read, and the MR snapshot that
 * `prPrecheckInfo` and `prReady` both need.
 *
 * Every read checks three things, in order: the exit code, an error BODY
 * (`glab api` exits 0 on an HTTP error and prints it; `detectGlabApiError`,
 * #502), and the shape the caller expects. Any miss is `ok: false`.
 */

import { detectGlabApiError } from '../gitlab-api.js';
import { runArgv } from '../shared/error-norm.js';
import type { PrPrecheckInfo } from './types.js';
import type { ReadResult } from './precheck-shared-github.js';

export const SHA_PATTERN = /^[0-9a-f]{40}$/i;
export const BRANCH_CHARSET = /^[A-Za-z0-9._\-/]+$/;
// GitLab nested groups: any depth of `/`-separated segments (lib/schemas/repo.ts, #290).
export const GITLAB_REPO_SLUG = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)+$/;

export function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

/** `projects/<this>/…`: the URL-encoded slug, or glab's `:id` (resolved from cwd). */
export function gitlabProject(repo: string | undefined): string {
  return repo !== undefined ? encodeURIComponent(repo) : ':id';
}

export function glabApiJson(argv: string[], code: string, what: string): ReadResult<unknown> {
  const result = runArgv(['glab', 'api', ...argv], projectDir());
  if (result.exitCode !== 0) {
    return { ok: false, code, error: `could not read ${what}: ${result.stderr.trim() || result.stdout.trim()}` };
  }
  const apiError = detectGlabApiError(result.stdout);
  if (apiError !== undefined) {
    return { ok: false, code, error: `could not read ${what}: ${apiError}` };
  }
  try {
    return { ok: true, data: JSON.parse(result.stdout) as unknown };
  } catch {
    return { ok: false, code, error: `${what}: unparseable glab api output` };
  }
}

/** An MR as `GET projects/:id/merge_requests/:iid` reports it. Fails closed. */
export function viewMrGitlab(number: number, repo: string | undefined, code: string): ReadResult<PrPrecheckInfo> {
  if (repo !== undefined && !GITLAB_REPO_SLUG.test(repo)) {
    return { ok: false, code: 'invalid_repo', error: `invalid repo slug ${JSON.stringify(repo)}` };
  }
  const read = glabApiJson([`projects/${gitlabProject(repo)}/merge_requests/${String(number)}`], code, `MR !${number}`);
  if (!read.ok) return read;
  const mr = read.data as Record<string, unknown> | null;
  if (mr === null || typeof mr !== 'object' || Array.isArray(mr)) {
    return { ok: false, code, error: `MR !${number}: response is not a merge request` };
  }
  const diffRefs = mr.diff_refs as { head_sha?: unknown } | null | undefined;
  const sha = diffRefs?.head_sha ?? mr.sha;
  // GitLab 14.0+ reports `draft`; older ones only `work_in_progress`. A missing
  // or non-boolean value must never read as "not a draft".
  const draft = typeof mr.draft === 'boolean' ? mr.draft : mr.work_in_progress;
  if (typeof sha !== 'string' || !SHA_PATTERN.test(sha) || typeof draft !== 'boolean') {
    return { ok: false, code, error: `MR !${number}: response lacks a head sha or draft state` };
  }
  // `locked` is GitLab's transient state while an MR merges, or after its
  // discussion is locked: still open, so it is gated. An unknown state is a
  // read failure, never "not open" (which the gate would pass ungated).
  const states: Record<string, PrPrecheckInfo['state']> = { opened: 'open', locked: 'open', merged: 'merged', closed: 'closed' };
  const state = typeof mr.state === 'string' ? states[mr.state] : undefined;
  if (state === undefined) {
    return { ok: false, code, error: `MR !${number}: unknown state ${JSON.stringify(mr.state)}` };
  }
  const sameRepo =
    typeof mr.source_project_id === 'number' && mr.source_project_id === mr.target_project_id;
  return {
    ok: true,
    data: {
      head_sha: sha,
      head_ref: typeof mr.source_branch === 'string' ? mr.source_branch : '',
      base_ref: typeof mr.target_branch === 'string' ? mr.target_branch : '',
      title: typeof mr.title === 'string' ? mr.title : '',
      body: typeof mr.description === 'string' ? mr.description : '',
      draft,
      state,
      same_repo: sameRepo,
    },
  };
}
