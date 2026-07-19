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
 * The `normalizeGithubState` / `normalizeGithubMergeState`
 * helpers are preserved verbatim from the pre-migration handler — that logic
 * is correct as-is and the existing integration tests in `tests/pr_status.test.ts`
 * lock its behavior.
 */

import { execSync } from 'child_process';
import { runArgv } from '../shared/error-norm.js';
import { classifyRun, describeFailedQuery, renderArgv } from '../shared/query-outcome.js';
import { classifyRollupItem, type RollupItem } from './pr-wait-ci-github.js';
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


/**
 * Aggregate a `statusCheckRollup` into the `pr_status` checks shape (#491).
 *
 * Reuses `classifyRollupItem` from `pr-wait-ci-github.ts` rather than adding a
 * second classifier, so `pr_status` and `pr_wait_ci` cannot disagree about what
 * a given check means — the disagreement that surfaced this bug (one reported
 * `4/4 passed` while the other reported `none`, seconds apart, same PR).
 *
 * `skipping` counts as passed: a skipped or stale check is not a blocker, which
 * is the same judgement `pr_wait_ci` already makes at the DECISION level
 * (`decide()` returns passed when pending === 0 && failed === 0, #221).
 *
 * The COUNTS differ deliberately: `snapshotGithub` leaves skipped checks
 * uncounted while still setting `total = checks.length`, so an all-skipped PR
 * prints `0/4` there and `4/4` here. Same verdict, different arithmetic — kept
 * so `passed + failed + pending === total` holds in this aggregate, which the
 * `pr_status` response shape implies. Noted rather than silently divergent,
 * because a cosmetic disagreement between these two tools is exactly what got
 * #491 reported.
 */
export function aggregateRollup(items: RollupItem[]): PrStatusChecksAggregate {
  let passed = 0;
  let failed = 0;
  let pending = 0;

  for (const item of items) {
    const bucket = classifyRollupItem(item);
    if (bucket === 'pass' || bucket === 'skipping') passed += 1;
    else if (bucket === 'fail') failed += 1;
    else pending += 1;
  }

  const total = items.length;
  let summary: PrStatusChecksSummary;
  if (total === 0) {
    // A genuine zero — the query SUCCEEDED and the PR has no checks. Distinct
    // from the failure path above, which returns an error instead.
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

    // 1. gh pr view — one call, checks included (#491).
    //
    // `statusCheckRollup` is requested HERE rather than via a second
    // `gh pr checks --json` subprocess. Two reasons, both load-bearing:
    //
    //   * `gh pr checks --json` DOES NOT EXIST on gh 2.45 (what Ubuntu 24.04
    //     LTS ships). It exits non-zero with `unknown flag: --json`, and the
    //     old code treated that failure as "no checks configured" — so this
    //     tool reported `checks: none` for PRs with passing checks, on every
    //     GitHub PR, permanently. `pr_wait_ci` was migrated off that same flag
    //     by #220; `pr_status` never received the fix.
    //   * Folding it into the existing view call removes the second subprocess
    //     entirely, and with it the whole category of "the second query failed
    //     and nobody noticed".
    const viewCmd = [
      'gh', 'pr', 'view', String(args.number),
      '--json', 'state,mergeStateStatus,mergeable,url,statusCheckRollup',
    ];
    if (args.repo !== undefined) viewCmd.push('--repo', args.repo);

    interface PrView {
      state: string;
      mergeStateStatus: string;
      mergeable: string | boolean;
      url: string;
      statusCheckRollup?: RollupItem[] | null;
    }

    // #493: classify the run rather than hand-checking exitCode and leaving
    // JSON.parse to throw into the generic catch. A failed query and an
    // unparseable payload are BOTH "we did not learn the state" — they get one
    // named code, and neither can be mistaken for a successful empty result.
    const viewOutcome = classifyRun<PrView>(
      runArgv(viewCmd, cwd),
      (stdout) => JSON.parse(stdout) as PrView,
      `PR #${String(args.number)} view`,
    );
    if (!viewOutcome.succeeded) {
      return {
        ok: false,
        // Distinct codes: the command failing and the command returning garbage
        // are different diagnoses, and collapsing them would reintroduce the
        // distinguishability loss this fix is about (#493).
        code: viewOutcome.kind === 'parse' ? 'gh_pr_view_unparseable' : 'gh_pr_view_failed',
        error: describeFailedQuery({
          what: `PR #${String(args.number)} status`,
          failure: viewOutcome.failure,
          argv: viewOutcome.argv,
        }),
      };
    }
    const pr = viewOutcome.value;

    const state = normalizeGithubState(pr.state);
    const merge_state = normalizeGithubMergeState(pr.mergeStateStatus);
    // GitHub `mergeable` comes back as "MERGEABLE" | "CONFLICTING" | "UNKNOWN" or bool.
    const mergeableRaw =
      typeof pr.mergeable === 'string' ? pr.mergeable.toUpperCase() : pr.mergeable;
    const mergeable =
      mergeableRaw === true || mergeableRaw === 'MERGEABLE' ? true : false;

    // 2. Aggregate checks from the rollup we already fetched.
    //
    // #491/#493: a MISSING field is NOT an empty result. `gh` always returns a
    // requested `--json` key, so an absent `statusCheckRollup` means we did not
    // successfully learn the check state — and reporting that as `summary:
    // 'none'` is the silent-permissive failure this fix exists to remove.
    //
    // We fail the whole call rather than inventing a summary. That is the
    // fail-CLOSED direction and it matters concretely: `/mmr` stops on an
    // `{ok:false}` envelope, but treats an unrecognised `checks.summary` as
    // permission to proceed (it only halts on `has_failures`). Returning a new
    // summary variant would therefore still merge; returning an error stops.
    if (pr.statusCheckRollup === undefined || pr.statusCheckRollup === null) {
      return {
        ok: false,
        code: 'gh_status_check_rollup_missing',
        error:
          `gh pr view returned no statusCheckRollup field for PR #${String(args.number)}. ` +
          'Check state is UNKNOWN, not absent — refusing to report it as "no checks". ' +
          `Command run: ${renderArgv(viewCmd)}`,
      };
    }
    const checks: PrStatusChecksAggregate = aggregateRollup(pr.statusCheckRollup);

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
