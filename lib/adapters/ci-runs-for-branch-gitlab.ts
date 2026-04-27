/**
 * GitLab `ci_runs_for_branch` adapter implementation.
 *
 * Lifted from `handlers/ci_runs_for_branch.ts` per Story 2.14 (#308). Mirrors
 * `ci-runs-for-branch-github.ts` — the handler dispatches to either depending
 * on cwd platform.
 *
 * GitLab divergences from the GitHub flow:
 * - No server-side status filter on `GET /projects/:id/pipelines`. We fetch
 *   `limit * 3` records when a status filter is set and filter client-side,
 *   then truncate to `limit` — same strategy the pre-migration handler used.
 * - `gitlabStatusFlag` translates the caller enum (`success | failure |
 *   in_progress | all`) to the GitLab-native vocabulary (`success | failed |
 *   running`). This lives next to the query that produces the raw values.
 * - `gitlabApiCiList` (the `glab api projects/.../pipelines` wrapper) lives
 *   in `lib/gitlab-api.ts` and is shared with `ci_wait_run` + `ci_run_status`.
 * - `workflow_name` falls back to the pipeline `source` field (push,
 *   merge_request_event, schedule, …); GitLab pipelines don't carry a
 *   separate workflow name the way GitHub runs do.
 * - `conclusion` is derived from the terminal status (`success | failed |
 *   canceled`) so consumers get a consistent shape across platforms.
 */

import { execSync } from 'child_process';
import { gitlabApiCiList } from '../gitlab-api.js';
import type {
  AdapterResult,
  CiRunsForBranchArgs,
  CiRunsForBranchResponse,
  CiRunsForBranchRun,
} from './types.js';

function splitRepoSlug(
  repo: string | undefined,
): { owner: string; repo: string } | undefined {
  if (!repo) return undefined;
  const [owner, name] = repo.split('/', 2);
  return { owner, repo: name };
}

// Map the caller's normalized status filter to the GitLab-native pipeline
// status value. `all` yields `null` — no filtering applied.
export function gitlabStatusFlag(
  status: CiRunsForBranchArgs['status'],
): string | null {
  switch (status) {
    case 'success':
      return 'success';
    case 'failure':
      return 'failed';
    case 'in_progress':
      return 'running';
    case 'all':
    default:
      return null;
  }
}

export async function ciRunsForBranchGitlab(
  args: CiRunsForBranchArgs,
): Promise<AdapterResult<CiRunsForBranchResponse>> {
  try {
    // GitLab API doesn't support status filtering, so fetch more and filter
    // client-side.
    const fetchLimit = args.status === 'all' ? args.limit : args.limit * 3;
    const pipelines = gitlabApiCiList(
      { ref: args.branch, limit: fetchLimit },
      splitRepoSlug(args.repo),
    );

    const targetStatus = gitlabStatusFlag(args.status);
    const filtered = targetStatus
      ? pipelines.filter((p) => p.status === targetStatus)
      : pipelines;

    const runs: CiRunsForBranchRun[] = filtered.slice(0, args.limit).map((p) => {
      // GitLab pipelines don't expose a separate status/conclusion; derive
      // conclusion from the terminal state so consumers get a consistent shape
      // across platforms.
      const terminal =
        p.status === 'success' || p.status === 'failed' || p.status === 'canceled';
      return {
        run_id: p.id,
        workflow_name: p.source ?? 'pipeline',
        status: p.status,
        conclusion: terminal ? p.status : null,
        sha: p.sha,
        url: p.web_url,
        created_at: p.created_at ?? '',
      };
    });

    return { ok: true, data: { runs } };
  } catch (err) {
    return {
      ok: false,
      code: 'glab_api_pipelines_failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// `execSync` is intentionally re-imported above so that adapter-level test
// files can `mock.module('child_process', ...)` and intercept the subprocess
// calls inside `gitlabApiCiList` without needing access to the handler's
// mock setup.
void execSync;
