/**
 * GitHub `ciListRuns` adapter implementation — the `ci_wait_run` keystone
 * hybrid sub-call (Story 2.19, #313).
 *
 * Lifted from `handlers/ci_wait_run.ts`'s local `fetchGithubRuns` helper.
 * Returns a richer normalized record than `ciRunStatus` / `ciRunsForBranch` —
 * the `event` field (the merge-result discriminator, #476) and `head_sha` (for the
 * `expected_sha` anchor) are what set this sub-call apart from the existing
 * fully-migrated CI adapters. Those fields drive the merge-result
 * pre-flight inside `lib/ci-wait-run-poll.ts`.
 *
 * Argv composition:
 *   gh run list (--commit <sha> | --branch <ref>) [--workflow <name>]
 *     [--repo <slug>] --limit <n>
 *     --json databaseId,name,status,conclusion,url,headSha,headBranch,
 *            workflowName,createdAt,event
 *
 * When `expected_sha` is set, the SHA is the authoritative anchor: always
 * passed as `--commit`. For branch refs we ALSO pass `--branch` so `gh`
 * narrows by both. When `expected_sha` is omitted, the ref itself drives
 * selection (SHA → `--commit`; branch name → `--branch`).
 *
 * Errors surface as typed `AdapterResult.error` so the polling loop never
 * has to try/catch.
 */

import { execSync } from 'child_process';
import { shortRefName } from '../shared/query-outcome.js';
import { runArgv } from '../shared/error-norm.js';
import type {
  AdapterResult,
  CiListRunsArgs,
  CiListRunsResponse,
  NormalizedCiRun,
} from './types.js';

const SHA_PATTERN = /^[0-9a-f]{40}$/i;

interface GhRun {
  databaseId: number;
  name?: string;
  workflowName?: string;
  status: string;
  conclusion: string | null;
  url: string;
  headSha: string;
  headBranch?: string;
  createdAt?: string;
  event?: string;
}

function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

function isSha(ref: string): boolean {
  return SHA_PATTERN.test(ref);
}

function normalizeGh(run: GhRun): NormalizedCiRun {
  return {
    run_id: run.databaseId,
    workflow_name: run.workflowName ?? run.name ?? '(unknown)',
    status: run.status,
    conclusion: run.conclusion ?? null,
    url: run.url,
    head_sha: run.headSha,
    head_branch: run.headBranch ?? null,
    created_at: run.createdAt ?? null,
    event: run.event ?? null,
  };
}

export async function ciListRunsGithub(
  args: CiListRunsArgs,
): Promise<AdapterResult<CiListRunsResponse>> {
  try {
    const cwd = projectDir();

    const cmd: string[] = ['gh', 'run', 'list'];
    // Ref selection. When expected_sha is provided the SHA is authoritative
    // (always --commit); for branch refs we additionally pass --branch so
    // `gh` narrows by both. Without expected_sha the ref drives selection.
    // `--branch` matches gh's `headBranch`, which for a TAG-triggered run is the
    // bare tag name — so `refs/tags/v1.1.0` matches nothing and the caller is
    // told the pipeline never ran. Measured live: `--branch refs/tags/v8.2.0`
    // returned 0 runs, `--branch v8.2.0` returned 2, for the same tag. The repo
    // normalised `refs/heads/` in two places and `refs/tags/` in none (#492).
    const branchRef = shortRefName(args.ref);
    if (args.expected_sha !== undefined) {
      if (!isSha(args.ref)) cmd.push('--branch', branchRef);
      cmd.push('--commit', args.expected_sha);
    } else if (isSha(args.ref)) {
      cmd.push('--commit', args.ref);
    } else {
      cmd.push('--branch', branchRef);
    }
    if (args.workflow_name !== undefined) {
      cmd.push('--workflow', args.workflow_name);
    }
    if (args.repo !== undefined) {
      cmd.push('--repo', args.repo);
    }
    cmd.push('--limit', String(args.limit));
    cmd.push(
      '--json',
      'databaseId,name,status,conclusion,url,headSha,headBranch,workflowName,createdAt,event',
    );

    const result = runArgv(cmd, cwd);
    if (result.exitCode !== 0) {
      return {
        ok: false,
        code: 'gh_run_list_failed',
        error: `gh run list failed: ${result.stderr.trim() || result.stdout.trim()}`,
        queried_argv: result.argv,
      };
    }

    const raw = result.stdout.trim();
    if (!raw) return { ok: true, data: [], queried_argv: result.argv };

    const runs = JSON.parse(raw) as GhRun[];
    if (!Array.isArray(runs)) {
      return {
        ok: false,
        code: 'gh_run_list_bad_shape',
        error: `gh run list returned non-array JSON: ${String(runs).slice(0, 200)}`,
        queried_argv: result.argv,
      };
    }
    return { ok: true, data: runs.map(normalizeGh), queried_argv: result.argv };
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