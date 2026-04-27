/**
 * GitLab `ci_run_status` adapter implementation.
 *
 * Lifted from `handlers/ci_run_status.ts` per Story 2.13 (#307). Mirrors
 * `ci-run-status-github.ts` — the handler dispatches to either depending on
 * cwd platform.
 *
 * GitLab divergences from the GitHub flow:
 * - No CLI-side workflow filter. GitLab pipelines don't carry a workflow
 *   "name" the way GitHub runs do; we list pipelines for the ref and then
 *   apply `workflow_name` client-side against the `source` field for
 *   best-effort matching. When `workflow_name` is set we fetch a deeper
 *   window (20) so the filter has something to chew on; otherwise just 1.
 * - `gitlabApiCiList` (the `glab api projects/.../pipelines` wrapper) lives
 *   in `lib/gitlab-api.ts` and is shared with `ci_wait_run` +
 *   `ci_runs_for_branch`.
 * - Status enum mapping diverges: GitLab statuses (`created`, `pending`,
 *   `running`, `success`, `failed`, `canceled`, `skipped`, …) normalize
 *   differently than GitHub's, so `normalizeGl*` lives here next to the
 *   query that produces the raw values.
 */

import { execSync } from 'child_process';
import { gitlabApiCiList, type GitlabPipeline } from '../gitlab-api.js';
import type {
  AdapterResult,
  CiRunConclusion,
  CiRunStatus,
  CiRunStatusArgs,
  CiRunStatusResponse,
  NormalizedRun,
} from './types.js';

function splitRepoSlug(
  repo: string | undefined,
): { owner: string; repo: string } | undefined {
  if (!repo) return undefined;
  const [owner, name] = repo.split('/', 2);
  return { owner, repo: name };
}

function normalizeGlStatus(status: string): CiRunStatus {
  switch (status) {
    case 'created':
    case 'waiting_for_resource':
    case 'preparing':
    case 'pending':
    case 'scheduled':
    case 'manual':
      return 'queued';
    case 'running':
      return 'in_progress';
    case 'success':
    case 'failed':
    case 'canceled':
    case 'cancelled':
    case 'skipped':
      return 'completed';
    default:
      return 'completed';
  }
}

function normalizeGlConclusion(status: string): CiRunConclusion | null {
  switch (status) {
    case 'success':
      return 'success';
    case 'failed':
      return 'failure';
    case 'canceled':
    case 'cancelled':
      return 'cancelled';
    case 'skipped':
      return 'skipped';
    default:
      return null;
  }
}

function normalizeGl(run: GitlabPipeline): NormalizedRun {
  const status = normalizeGlStatus(run.status);
  const conclusion = normalizeGlConclusion(run.status);
  return {
    run_id: run.id,
    workflow_name: run.source ?? '',
    status,
    conclusion,
    url: run.web_url,
    ref: run.ref,
    sha: run.sha,
    created_at: run.created_at ?? '',
    finished_at:
      run.finished_at ?? (status === 'completed' ? run.updated_at ?? null : null),
  };
}

export async function ciRunStatusGitlab(
  args: CiRunStatusArgs,
): Promise<AdapterResult<CiRunStatusResponse>> {
  try {
    const limit = args.workflow_name ? 20 : 1;
    const runs = gitlabApiCiList(
      { ref: args.ref, limit },
      splitRepoSlug(args.repo),
    );

    const filtered = args.workflow_name
      ? runs.filter((r) => (r.source ?? '') === args.workflow_name)
      : runs;

    if (filtered.length === 0) return { ok: true, data: null };
    return { ok: true, data: normalizeGl(filtered[0]) };
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
