/**
 * GitHub `ci_runs_for_branch` adapter implementation.
 *
 * Lifted from `handlers/ci_runs_for_branch.ts` per Story 2.14 (#308). The
 * handler is now a thin dispatcher; this module owns the GitHub-specific
 * subprocess work (argv composition + `gh run list` invocation) AND the
 * caller-enum → platform-flag translation (`githubStatusFlag`).
 *
 * Argv composition:
 *   gh run list --branch <ref> --limit <n> [--status <flag>] [--repo <slug>]
 *     --json databaseId,name,status,conclusion,headSha,url,createdAt
 *
 * Status enum translation (caller-facing → `gh` flag):
 *   success    → --status success
 *   failure    → --status failure
 *   in_progress → --status in_progress
 *   all        → flag omitted (no --status)
 *
 * Normalized run shape (`RunRecord`) is the same struct consumers received
 * pre-migration; platform-native `status`/`conclusion` pass through unchanged.
 */

import { execSync } from 'child_process';
import { runArgv } from '../shared/error-norm.js';
import type {
  AdapterResult,
  CiRunsForBranchArgs,
  CiRunsForBranchResponse,
  CiRunsForBranchRun,
} from './types.js';

interface GithubRun {
  databaseId: number;
  name: string;
  status: string;
  conclusion: string | null;
  headSha: string;
  url: string;
  createdAt: string;
}

function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

// Map the caller's normalized status filter to the flag value `gh run list`
// expects. `all` yields `null` — the flag is omitted entirely.
export function githubStatusFlag(
  status: CiRunsForBranchArgs['status'],
): string | null {
  switch (status) {
    case 'success':
      return 'success';
    case 'failure':
      return 'failure';
    case 'in_progress':
      return 'in_progress';
    case 'all':
    default:
      return null;
  }
}

function normalizeGh(r: GithubRun): CiRunsForBranchRun {
  return {
    run_id: r.databaseId,
    workflow_name: r.name,
    status: r.status,
    conclusion: r.conclusion,
    sha: r.headSha,
    url: r.url,
    created_at: r.createdAt,
  };
}

export async function ciRunsForBranchGithub(
  args: CiRunsForBranchArgs,
): Promise<AdapterResult<CiRunsForBranchResponse>> {
  try {
    const cwd = projectDir();

    const cmd: string[] = ['gh', 'run', 'list'];
    cmd.push('--branch', args.branch);
    cmd.push('--limit', String(args.limit));
    const statusFlag = githubStatusFlag(args.status);
    if (statusFlag !== null) cmd.push('--status', statusFlag);
    if (args.repo !== undefined) cmd.push('--repo', args.repo);
    cmd.push('--json', 'databaseId,name,status,conclusion,headSha,url,createdAt');

    const result = runArgv(cmd, cwd);
    if (result.exitCode !== 0) {
      return {
        ok: false,
        code: 'gh_run_list_failed',
        error: `gh run list failed: ${result.stderr.trim() || result.stdout.trim()}`,
      };
    }

    const raw = result.stdout.trim();
    if (!raw) return { ok: true, data: { runs: [] } };

    const runs = JSON.parse(raw) as GithubRun[];
    return { ok: true, data: { runs: runs.map(normalizeGh) } };
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
