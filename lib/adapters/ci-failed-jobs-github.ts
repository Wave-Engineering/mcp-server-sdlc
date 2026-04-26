/**
 * GitHub `ci_failed_jobs` adapter implementation.
 *
 * Lifted from `handlers/ci_failed_jobs.ts` per Story 2.11 (#305). The handler
 * is now a thin dispatcher; this module owns the GitHub-specific subprocess
 * work and normalizes the response into `AdapterResult<CiFailedJobsResponse>`.
 *
 * Errors that come back from `gh` are converted into `{ok: false, error, code}`
 * — never thrown — so the handler doesn't need a try/catch around the dispatch.
 */

import { execSync } from 'child_process';
import { runArgv } from '../shared/error-norm.js';
import type {
  AdapterResult,
  CiFailedJobsArgs,
  CiFailedJobsResponse,
  FailedJob,
} from './types.js';

// GitHub job shape from `gh run view <id> --json jobs`.
interface GithubJob {
  databaseId?: number;
  name?: string;
  status?: string;
  conclusion?: string;
  startedAt?: string;
  completedAt?: string;
  url?: string;
}

function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

function normalizeGithubConclusion(raw: string | undefined): string {
  // GitHub conclusion values: success, failure, cancelled, timed_out,
  // action_required, neutral, skipped, stale, startup_failure.
  if (!raw) return 'failure';
  return raw;
}

export async function ciFailedJobsGithub(
  args: CiFailedJobsArgs,
): Promise<AdapterResult<CiFailedJobsResponse>> {
  // Bound any exception that escapes the helpers below into a typed result —
  // adapter callers must not have to try/catch.
  try {
    const cwd = projectDir();

    const cmd = ['gh', 'run', 'view', String(args.run_id), '--json', 'jobs'];
    if (args.repo !== undefined) cmd.push('--repo', args.repo);
    const result = runArgv(cmd, cwd);
    if (result.exitCode !== 0) {
      return {
        ok: false,
        code: 'gh_run_view_failed',
        error: `gh run view failed: ${result.stderr.trim() || result.stdout.trim()}`,
      };
    }

    const parsed = JSON.parse(result.stdout) as { jobs?: GithubJob[] };
    const jobs = parsed.jobs ?? [];
    const failed: FailedJob[] = [];
    for (const j of jobs) {
      if (j.status !== 'completed') continue;
      if (j.conclusion === 'success') continue;
      failed.push({
        job_id: j.databaseId ?? 0,
        name: j.name ?? '',
        stage: null,
        conclusion: normalizeGithubConclusion(j.conclusion),
        started_at: j.startedAt ?? null,
        finished_at: j.completedAt ?? null,
        url: j.url ?? '',
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

// `execSync` is intentionally re-imported above so that adapter-level test
// files can `mock.module('child_process', ...)` and intercept this module's
// subprocess calls without needing access to the handler's mock setup.
void execSync;
