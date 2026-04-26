/**
 * GitLab `ci_run_logs` adapter implementation.
 *
 * Lifted from `handlers/ci_run_logs.ts` per Story 2.12 (#306). Mirrors
 * `ci-run-logs-github.ts` — the handler dispatches to either depending on
 * cwd platform.
 *
 * GitLab divergences from the GitHub flow:
 * - When `job_id` is omitted, we have to resolve the failed job first via
 *   `glab api projects/:id/pipelines/<run_id>/jobs` (REST endpoint) and then
 *   fetch the trace. GitHub's `gh run view` collapses that into one call via
 *   `--log-failed`; GitLab has no equivalent.
 * - `glab ci trace <job_id>` fetches the log. Cross-repo targeting uses the
 *   `-R <slug>` flag (verified against installed glab version) — the `api`
 *   subcommand needs a URL-encoded project path instead.
 * - `failed_only` is semantically fulfilled by the job-resolution step (we
 *   pick the first `status === 'failed'` job). When the caller passes an
 *   explicit `job_id`, `failed_only` is ignored — they asked for that
 *   specific job's trace.
 */

import { execSync } from 'child_process';
import { runArgv } from '../shared/error-norm.js';
import { parseRepoSlug } from '../shared/parse-repo-slug.js';
import type {
  AdapterResult,
  CiRunLogsArgs,
  CiRunLogsResponse,
} from './types.js';

// GitLab job shape from `glab api projects/:id/pipelines/<id>/jobs`.
// Only the fields we read for failed-job resolution.
interface GitlabJob {
  id: number;
  status: string;
}

function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

function resolveFailedJob(
  args: CiRunLogsArgs,
  cwd: string,
): { ok: true; job_id: number } | { ok: false; code: string; error: string } {
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

  const jobs = JSON.parse(result.stdout) as GitlabJob[];
  const failed = jobs.find((j) => j.status === 'failed');
  if (!failed) {
    return {
      ok: false,
      code: 'no_failed_job',
      error: `no failed job found in pipeline ${args.run_id}`,
    };
  }
  return { ok: true, job_id: failed.id };
}

export async function ciRunLogsGitlab(
  args: CiRunLogsArgs,
): Promise<AdapterResult<CiRunLogsResponse>> {
  try {
    const cwd = projectDir();

    let jobId = args.job_id;
    if (jobId === undefined) {
      const resolved = resolveFailedJob(args, cwd);
      if (!resolved.ok) {
        return { ok: false, code: resolved.code, error: resolved.error };
      }
      jobId = resolved.job_id;
    }

    const traceCmd: string[] = ['glab', 'ci', 'trace', String(jobId)];
    if (args.repo !== undefined) {
      // `glab ci trace` supports `-R owner/repo` for cross-repo targeting —
      // verified against the installed glab version.
      traceCmd.push('-R', args.repo);
    }

    const trace = runArgv(traceCmd, cwd);
    if (trace.exitCode !== 0) {
      return {
        ok: false,
        code: 'glab_ci_trace_failed',
        error: `glab ci trace failed: ${trace.stderr.trim() || trace.stdout.trim()}`,
      };
    }

    const slug = args.repo ?? parseRepoSlug();
    const url = slug
      ? `https://gitlab.com/${slug}/-/jobs/${jobId}`
      : `https://gitlab.com/-/jobs/${jobId}`;

    return {
      ok: true,
      data: {
        logs: trace.stdout,
        job_id: jobId,
        url,
      },
    };
  } catch (err) {
    return {
      ok: false,
      code: 'unexpected_error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// See ci-run-logs-github.ts for the rationale.
void execSync;
