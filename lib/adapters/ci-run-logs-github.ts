/**
 * GitHub `ci_run_logs` adapter implementation.
 *
 * Lifted from `handlers/ci_run_logs.ts` per Story 2.12 (#306). The handler is
 * now a thin dispatcher; this module owns the GitHub-specific subprocess work
 * and normalizes the response into `AdapterResult<CiRunLogsResponse>`.
 *
 * Argv composition:
 *   gh run view <run_id> [--job <job_id>] (--log | --log-failed) [--repo <slug>]
 *
 * URL construction:
 *   Prefers the caller-supplied `repo` slug. Falls back to `parseRepoSlug()`
 *   against the cwd's git remote when `repo` is omitted — preserving the
 *   behavior of the pre-migration handler. If neither is available, emits a
 *   best-effort `https://github.com/actions/runs/<id>` URL that at least
 *   encodes the run id.
 */

import { execSync } from 'child_process';
import { runArgv } from '../shared/error-norm.js';
import { parseRepoSlug } from '../shared/parse-repo-slug.js';
import type {
  AdapterResult,
  CiRunLogsArgs,
  CiRunLogsResponse,
} from './types.js';

function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

export async function ciRunLogsGithub(
  args: CiRunLogsArgs,
): Promise<AdapterResult<CiRunLogsResponse>> {
  try {
    const cwd = projectDir();

    const cmd: string[] = ['gh', 'run', 'view', String(args.run_id)];
    if (args.job_id !== undefined) {
      cmd.push('--job', String(args.job_id));
    }
    cmd.push(args.failed_only ? '--log-failed' : '--log');
    if (args.repo !== undefined) {
      cmd.push('--repo', args.repo);
    }

    const result = runArgv(cmd, cwd);
    if (result.exitCode !== 0) {
      return {
        ok: false,
        code: 'gh_run_view_failed',
        error: `gh run view failed: ${result.stderr.trim() || result.stdout.trim()}`,
      };
    }

    // When `repo` is explicitly provided, use it directly for URL construction
    // — skip the cwd-based parseRepoSlug fallback entirely.
    const slug = args.repo ?? parseRepoSlug();
    const url = slug
      ? `https://github.com/${slug}/actions/runs/${args.run_id}`
      : `https://github.com/actions/runs/${args.run_id}`;

    return {
      ok: true,
      data: {
        logs: result.stdout,
        job_id: args.job_id ?? null,
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

// `execSync` is intentionally re-imported above so that adapter-level test
// files can `mock.module('child_process', ...)` and intercept this module's
// subprocess calls without needing access to the handler's mock setup.
void execSync;
