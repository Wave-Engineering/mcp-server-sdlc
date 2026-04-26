/**
 * GitHub `pr_files` adapter implementation.
 *
 * Lifted from `handlers/pr_files.ts` per Story 1.5. The handler is now a
 * thin dispatcher; this module owns the GitHub-specific subprocess work and
 * normalizes the response into `AdapterResult<PrFilesResponse>`.
 *
 * Errors that come back from `gh` are converted into `{ok: false, error, code}`
 * — never thrown — so the handler doesn't need a try/catch around the dispatch.
 *
 * `mapGithubChangeType` stays inline; it's a tiny single-consumer helper that
 * doesn't earn its keep as a shared module.
 */

import { execSync } from 'child_process';
import { runArgv } from '../shared/error-norm.js';
import type {
  AdapterResult,
  PrFilesArgs,
  PrFilesEntry,
  PrFilesResponse,
  PrFilesStatus,
} from './types.js';

function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

function mapGithubChangeType(changeType: string): PrFilesStatus {
  switch (changeType.toUpperCase()) {
    case 'ADDED':
      return 'added';
    case 'REMOVED':
    case 'DELETED':
      return 'removed';
    case 'RENAMED':
      return 'renamed';
    case 'MODIFIED':
    case 'CHANGED':
    default:
      return 'modified';
  }
}

interface GithubFile {
  path: string;
  additions: number;
  deletions: number;
  changeType: string;
}

export async function prFilesGithub(
  args: PrFilesArgs,
): Promise<AdapterResult<PrFilesResponse>> {
  // Bound any exception that escapes the helpers below into a typed result —
  // adapter callers must not have to try/catch.
  try {
    const cwd = projectDir();

    const cmd = ['gh', 'pr', 'view', String(args.number), '--json', 'files'];
    if (args.repo !== undefined) cmd.push('--repo', args.repo);
    const result = runArgv(cmd, cwd);
    if (result.exitCode !== 0) {
      return {
        ok: false,
        code: 'gh_pr_view_failed',
        error: `gh pr view failed: ${result.stderr.trim() || result.stdout.trim()}`,
      };
    }

    const parsed = JSON.parse(result.stdout) as { files?: GithubFile[] };
    const rawFiles = parsed.files ?? [];
    const files: PrFilesEntry[] = rawFiles.map((f) => ({
      path: f.path,
      status: mapGithubChangeType(f.changeType),
      additions: typeof f.additions === 'number' ? f.additions : 0,
      deletions: typeof f.deletions === 'number' ? f.deletions : 0,
    }));

    const total_additions = files.reduce((sum, f) => sum + f.additions, 0);
    const total_deletions = files.reduce((sum, f) => sum + f.deletions, 0);

    return {
      ok: true,
      data: {
        number: args.number,
        files,
        total_additions,
        total_deletions,
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
