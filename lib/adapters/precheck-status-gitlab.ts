/**
 * GitLab `precheckStatus` adapter (#592): the latest `precheck` commit status
 * on a SHA.
 *
 * Argv: `glab api projects/<id>/repository/commits/<sha>/statuses?name=precheck&per_page=100`.
 * Without `all=true` GitLab returns only the latest status per name and ref;
 * if several refs carry one, the newest (highest id) wins.
 *
 * FAILS CLOSED: an exit code, an error body, or a response that is not a list
 * is `ok: false`. An empty list is `none`. `detectGlabApiError` never flags an
 * array, so the list check is what separates an answer from an error here.
 */

import { execSync } from 'child_process';
import type { AdapterResult, PrecheckState, PrecheckStatusArgs, PrecheckStatusResponse } from './types.js';
import { GITLAB_REPO_SLUG, SHA_PATTERN, gitlabProject, glabApiJson } from './precheck-shared-gitlab.js';
import { PRECHECK_CONTEXT } from './precheck-status-github.js';

const PENDING = new Set(['pending', 'running', 'created', 'waiting_for_resource', 'preparing', 'scheduled', 'manual']);

function normalize(status: unknown): PrecheckState {
  if (status === 'success') return 'success';
  if (typeof status === 'string' && PENDING.has(status)) return 'pending';
  // `failed`, `canceled`, `skipped` and anything unrecognised: no pass.
  return 'failure';
}

export async function precheckStatusGitlab(
  args: PrecheckStatusArgs,
): Promise<AdapterResult<PrecheckStatusResponse>> {
  try {
    if (!SHA_PATTERN.test(args.sha)) {
      return { ok: false, code: 'invalid_sha', error: `precheckStatusGitlab: invalid sha ${JSON.stringify(args.sha)}` };
    }
    if (args.repo !== undefined && !GITLAB_REPO_SLUG.test(args.repo)) {
      return { ok: false, code: 'invalid_repo', error: `precheckStatusGitlab: invalid repo slug ${JSON.stringify(args.repo)}` };
    }
    const read = glabApiJson(
      [`projects/${gitlabProject(args.repo)}/repository/commits/${args.sha}/statuses?name=${PRECHECK_CONTEXT}&per_page=100`],
      'precheck_status_read_failed',
      `the precheck status of ${args.sha}`,
    );
    if (!read.ok) return read;
    if (!Array.isArray(read.data)) {
      return { ok: false, code: 'precheck_status_read_failed', error: `precheck status of ${args.sha}: response is not a list` };
    }
    let latest: { id: number; status: unknown } | undefined;
    for (const s of read.data as unknown[]) {
      if (s === null || typeof s !== 'object') continue;
      const { name, id, status } = s as { name?: unknown; id?: unknown; status?: unknown };
      if (name !== PRECHECK_CONTEXT || typeof id !== 'number') continue;
      if (latest === undefined || id > latest.id) latest = { id, status };
    }
    return { ok: true, data: { state: latest === undefined ? 'none' : normalize(latest.status) } };
  } catch (err) {
    return { ok: false, code: 'unexpected_error', error: err instanceof Error ? err.message : String(err) };
  }
}

void execSync;
