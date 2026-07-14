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
 * - `event` carries the pipeline's `source` — the merge-result discriminator (#476).
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
    // GitLab's `source` IS the trigger event — `push`, `merge_request_event`,
    // `schedule`, `web`, `api`, … (#476). It was previously hardcoded `null`,
    // which discarded the only field that distinguishes a *merged-results*
    // pipeline (`merge_request_event` — CI against the result of merging source
    // into target) from a plain *branch* pipeline (`push` — CI against the
    // source branch HEAD). The wave trust gate grades the merge result and must
    // never accept a branch pipeline in its place; without this field it cannot
    // tell them apart.
    event: pipeline.source ?? null,
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
