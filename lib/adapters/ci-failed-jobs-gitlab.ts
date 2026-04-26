/**
 * GitLab `ci_failed_jobs` adapter implementation.
 *
 * Lifted from `handlers/ci_failed_jobs.ts` per Story 2.11 (#305). Mirrors
 * `ci-failed-jobs-github.ts` — the handler dispatches to either depending on
 * cwd platform.
 *
 * GitLab divergences from the GitHub flow:
 * - `glab api projects/<id>/pipelines/<pid>/jobs` (REST endpoint) rather than
 *   a `gh`-style CLI subcommand.
 * - When `args.repo` is provided it's URL-encoded as the explicit project
 *   slug; otherwise `:id` is passed and `glab` substitutes the cwd project's
 *   numeric id.
 * - `stage` is populated from the job record (GitHub has no equivalent and
 *   returns `null` in the normalized shape).
 * - Status filtering uses `status === 'failed'` (GitLab) vs. GitHub's
 *   `status === 'completed' && conclusion !== 'success'`.
 */

import { execSync } from 'child_process';
import { runArgv } from '../shared/error-norm.js';
import type {
  AdapterResult,
  CiFailedJobsArgs,
  CiFailedJobsResponse,
  FailedJob,
} from './types.js';

// GitLab job shape from `glab api projects/:id/pipelines/<id>/jobs`.
interface GitlabJob {
  id?: number;
  name?: string;
  status?: string;
  stage?: string;
  started_at?: string | null;
  finished_at?: string | null;
  web_url?: string;
}

function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

function normalizeGitlabConclusion(raw: string | undefined): string {
  // GitLab job status after filtering to `failed`. Map onto GitHub-style
  // conclusions so `/jfail` can reason about both uniformly.
  if (!raw) return 'failure';
  if (raw === 'failed') return 'failure';
  return raw;
}

export async function ciFailedJobsGitlab(
  args: CiFailedJobsArgs,
): Promise<AdapterResult<CiFailedJobsResponse>> {
  try {
    const cwd = projectDir();
    const projectId = args.repo ? encodeURIComponent(args.repo) : ':id';
    const apiPath = `projects/${projectId}/pipelines/${args.run_id}/jobs`;

    const result = runArgv(['glab', 'api', apiPath], cwd);
    if (result.exitCode !== 0) {
      return {
        ok: false,
        code: 'glab_api_jobs_failed',
        error: `glab api failed: ${result.stderr.trim() || result.stdout.trim()}`,
      };
    }

    const parsed = JSON.parse(result.stdout) as GitlabJob[];
    const failed: FailedJob[] = [];
    for (const j of parsed) {
      if (j.status !== 'failed') continue;
      failed.push({
        job_id: j.id ?? 0,
        name: j.name ?? '',
        stage: j.stage ?? null,
        conclusion: normalizeGitlabConclusion(j.status),
        started_at: j.started_at ?? null,
        finished_at: j.finished_at ?? null,
        url: j.web_url ?? '',
      });
    }

    return { ok: true, data: { failed_jobs: failed } };
  } catch (err) {
    return {
      ok: false,
      code: 'unexpected_error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// See ci-failed-jobs-github.ts for the rationale.
void execSync;
