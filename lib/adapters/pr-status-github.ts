/**
 * GitHub `pr_status` adapter implementation.
 *
 * Lifted from `handlers/pr_status.ts` per Story 1.7. The handler is now a
 * thin dispatcher; this module owns the GitHub-specific subprocess work and
 * normalizes the response into `AdapterResult<PrStatusResponse>`.
 *
 * Errors that come back from `gh` are converted into `{ok: false, error, code}`
 * — never thrown — so the handler doesn't need a try/catch around the dispatch.
 *
 * The `aggregateGithubChecks` / `normalizeGithubState` / `normalizeGithubMergeState`
 * helpers are preserved verbatim from the pre-migration handler — that logic
 * is correct as-is and the existing integration tests in `tests/pr_status.test.ts`
 * lock its behavior.
 */

import { execSync } from 'child_process';
import { runArgv } from '../shared/error-norm.js';
import type {
  AdapterResult,
  PrStatusArgs,
  PrStatusChecksAggregate,
  PrStatusChecksSummary,
  PrStatusMergeState,
  PrStatusResponse,
  PrStatusState,
} from './types.js';

function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

// --- GitHub normalization (preserved verbatim from handlers/pr_status.ts) ---

function normalizeGithubState(state: string): PrStatusState {
  const s = state.toUpperCase();
  if (s === 'MERGED') return 'merged';
  if (s === 'CLOSED') return 'closed';
  return 'open';
}

function normalizeGithubMergeState(mergeStateStatus: string): PrStatusMergeState {
  const s = (mergeStateStatus || '').toUpperCase();
  if (s === 'CLEAN') return 'clean';
  if (s === 'UNSTABLE') return 'unstable';
  if (s === 'DIRTY') return 'dirty';
  if (s === 'BLOCKED') return 'blocked';
  return 'unknown';
}

interface GithubCheck {
  name?: string;
  state?: string;
  conclusion?: string | null;
}

export function aggregateGithubChecks(checks: GithubCheck[]): PrStatusChecksAggregate {
  let passed = 0;
  let failed = 0;
  let pending = 0;

  for (const c of checks) {
    const conclusion = (c.conclusion ?? '').toLowerCase();
    const state = (c.state ?? '').toLowerCase();

    if (conclusion === 'success' || state === 'success') {
      passed += 1;
    } else if (
      conclusion === 'failure' ||
      conclusion === 'cancelled' ||
      conclusion === 'timed_out' ||
      conclusion === 'action_required' ||
      state === 'failure'
    ) {
      failed += 1;
    } else {
      // null conclusion, in_progress, queued, pending, etc.
      pending += 1;
    }
  }

  const total = checks.length;
  let summary: PrStatusChecksSummary;
  if (total === 0) {
    summary = 'none';
  } else if (failed > 0) {
    summary = 'has_failures';
  } else if (pending > 0) {
    summary = 'pending';
  } else {
    summary = 'all_passed';
  }

  return { total, passed, failed, pending, summary };
}

export async function prStatusGithub(
  args: PrStatusArgs,
): Promise<AdapterResult<PrStatusResponse>> {
  // Bound any exception that escapes the helpers below into a typed result —
  // adapter callers must not have to try/catch.
  try {
    const cwd = projectDir();

    // 1. gh pr view
    const viewCmd = [
      'gh', 'pr', 'view', String(args.number),
      '--json', 'state,mergeStateStatus,mergeable,url',
    ];
    if (args.repo !== undefined) viewCmd.push('--repo', args.repo);

    const viewResult = runArgv(viewCmd, cwd);
    if (viewResult.exitCode !== 0) {
      return {
        ok: false,
        code: 'gh_pr_view_failed',
        error: `gh pr view failed: ${viewResult.stderr.trim() || viewResult.stdout.trim()}`,
      };
    }

    const pr = JSON.parse(viewResult.stdout) as {
      state: string;
      mergeStateStatus: string;
      mergeable: string | boolean;
      url: string;
    };

    const state = normalizeGithubState(pr.state);
    const merge_state = normalizeGithubMergeState(pr.mergeStateStatus);
    // GitHub `mergeable` comes back as "MERGEABLE" | "CONFLICTING" | "UNKNOWN" or bool.
    const mergeableRaw =
      typeof pr.mergeable === 'string' ? pr.mergeable.toUpperCase() : pr.mergeable;
    const mergeable =
      mergeableRaw === true || mergeableRaw === 'MERGEABLE' ? true : false;

    // 2. gh pr checks — non-fatal: a failure here means "no checks configured"
    //    rather than a hard error. Preserved from the pre-migration handler.
    let checks: PrStatusChecksAggregate = {
      total: 0,
      passed: 0,
      failed: 0,
      pending: 0,
      summary: 'none',
    };
    const checksCmd = [
      'gh', 'pr', 'checks', String(args.number),
      '--json', 'name,state,conclusion',
    ];
    if (args.repo !== undefined) checksCmd.push('--repo', args.repo);
    const checksResult = runArgv(checksCmd, cwd);
    if (checksResult.exitCode === 0) {
      try {
        const parsed = JSON.parse(checksResult.stdout) as GithubCheck[];
        checks = aggregateGithubChecks(parsed);
      } catch {
        // JSON parse failure — leave checks at the 'none' default.
      }
    }

    return {
      ok: true,
      data: {
        number: args.number,
        state,
        merge_state,
        mergeable,
        checks,
        url: pr.url,
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
