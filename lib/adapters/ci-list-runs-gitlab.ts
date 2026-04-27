/**
 * GitLab `ciListRuns` adapter implementation — the `ci_wait_run` keystone
 * hybrid sub-call (Story 2.19, #313).
 *
 * Mirrors `ci-list-runs-github.ts` — both implement the same normalized
 * `NormalizedCiRun[]` shape; `ci_wait_run`'s polling loop (in
 * `lib/ci-wait-run-poll.ts`) reads these records without branching on
 * platform.
 *
 * GitLab divergences:
 * - `event` is always `null`. GitLab pipelines don't carry a trigger-event
 *   in the GitHub-Actions sense; merge-queue pre-flight never fires for
 *   GitLab (R-03 typed asymmetry).
 * - `workflow_name` filtering is client-side against the `source` field —
 *   GitLab pipelines have no "workflow name". When the caller passes a
 *   `workflow_name` we fetch more pipelines than requested and filter down.
 * - `expected_sha` threads through as the `?sha=` query param on the GitLab
 *   REST endpoint; `gitlabApiCiList` handles the encoding.
 *
 * `gitlabApiCiList` lives in `lib/gitlab-api.ts` and is shared across the
 * CI family (`ci_wait_run`, `ci_run_status`, `ci_runs_for_branch`).
 */

import { execSync } from 'child_process';
import { gitlabApiCiList, type GitlabPipeline } from '../gitlab-api.js';
import type {
  AdapterResult,
  CiListRunsArgs,
  CiListRunsResponse,
  NormalizedCiRun,
} from './types.js';

function splitRepoSlug(
  repo: string | undefined,
): { owner: string; repo: string } | undefined {
  if (!repo) return undefined;
  const [owner, name] = repo.split('/', 2);
  return { owner, repo: name };
}

function normalizeGl(pipeline: GitlabPipeline): NormalizedCiRun {
  return {
    run_id: pipeline.id,
    workflow_name: pipeline.source ?? '(gitlab pipeline)',
    status: pipeline.status,
    conclusion: null,
    url: pipeline.web_url,
    head_sha: pipeline.sha,
    head_branch: pipeline.ref ?? null,
    created_at: pipeline.created_at ?? null,
    // GitLab has no GitHub-Actions-style trigger-event. Always null — the
    // merge-queue pre-flight skips on this signal (R-03 typed asymmetry).
    event: null,
  };
}

export async function ciListRunsGitlab(
  args: CiListRunsArgs,
): Promise<AdapterResult<CiListRunsResponse>> {
  try {
    const pipelines = gitlabApiCiList(
      { ref: args.ref, limit: args.limit, sha: args.expected_sha },
      splitRepoSlug(args.repo),
    );

    // Defense-in-depth: even if glab returns pipelines that don't match
    // `sha=<expected_sha>`, drop them. Mirrors the pre-migration handler's
    // airtight "ignores other runs on the same branch" guarantee.
    const shaFiltered = args.expected_sha
      ? pipelines.filter(
          (p) =>
            p.sha?.toLowerCase() === (args.expected_sha as string).toLowerCase(),
        )
      : pipelines;

    // GitLab pipelines have no workflow-name concept; fall back to client-side
    // filtering against the `source` field when the caller provided a filter.
    const workflowFiltered = args.workflow_name
      ? shaFiltered.filter((p) => p.source === args.workflow_name)
      : shaFiltered;

    return { ok: true, data: workflowFiltered.map(normalizeGl) };
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
