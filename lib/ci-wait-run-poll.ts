/**
 * Platform-agnostic polling loop + merge-queue pre-flight for `ci_wait_run`
 * (Story 2.19, #313).
 *
 * Lifted out of `handlers/ci_wait_run.ts` so the phased state machine isn't
 * duplicated per platform — same architectural rule as `lib/pr-wait-ci-poll.ts`
 * and `lib/pr-merge-wait-poll.ts`. Every subprocess touch goes through the
 * routed `getAdapter()` (via the `ciListRuns` + `resolveBranchSha` sub-calls),
 * so this module remains free of `gh`/`glab` invocations and platform
 * branching.
 *
 * Phases preserved verbatim from the pre-migration handler:
 * - Phase 0 (GitHub-only): merge-queue pre-flight. If the ref has NO
 *   push-triggered runs but DOES have a `merge_group` run matching its HEAD
 *   SHA, return `final_status: 'not_applicable'` with
 *   `reason: 'merge_group_validated'`. No push-triggered runs AND no
 *   matching merge_group → structured `not_applicable` error.
 * - Phase 1: wait for a run to appear (no-run-yet window). When
 *   `expected_sha` is set the window equals `timeout_sec`; otherwise a
 *   60s floor.
 * - Phase 2: poll the run until it completes or we time out.
 * - Phase 3: completed — map conclusion to `final_status`.
 *
 * Injectable `now`/`sleep` makes tests instant. The adapter object is
 * injectable too (`deps.adapter`) so tests can drive it directly without
 * going through `getAdapter()`.
 */

import type {
  CiListRunsArgs,
  NormalizedCiRun,
  PlatformAdapter,
  ResolveBranchShaArgs,
} from './adapters/types.js';
import { log } from '../logger.js';

// Defaults — lifted verbatim from the pre-migration handler.
export const DEFAULT_POLL_INTERVAL_SEC = 10;
export const MIN_POLL_INTERVAL_SEC = 5;
export const DEFAULT_TIMEOUT_SEC = 1800;
export const NO_RUN_YET_WINDOW_SEC = 60;
export const NO_RUN_YET_POLL_SEC = 5;
export const LIST_LIMIT = 20;

export type FinalStatus =
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'timed_out'
  | 'not_applicable';

export interface WaitArgs {
  ref: string;
  workflow_name?: string;
  poll_interval_sec?: number;
  timeout_sec?: number;
  repo?: string;
  expected_sha?: string;
  /** Original cwd-derived slug for branch→SHA resolution when `repo` is omitted. */
  cwd_repo_slug?: string | null;
  platform: 'github' | 'gitlab';
}

export interface WaitDeps {
  adapter: Pick<PlatformAdapter, 'ciListRuns' | 'resolveBranchSha'>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export type WaitResult =
  | {
      ok: true;
      final_status: FinalStatus;
      /** Present only on merge_group_validated path. */
      reason?: 'merge_group_validated';
      run_id?: number;
      workflow_name?: string;
      url?: string;
      ref: string;
      sha?: string;
      waited_sec: number;
      message?: string;
    }
  | {
      ok: false;
      error: string;
      final_status?: FinalStatus;
      run_id?: number;
      workflow_name?: string;
      url?: string;
      ref: string;
      sha?: string;
      waited_sec: number;
      platform?: 'github' | 'gitlab';
      expected_sha?: string;
    };

function isSha(ref: string): boolean {
  return /^[0-9a-f]{40}$/i.test(ref);
}

function shortRef(ref: string): string {
  return isSha(ref) ? ref.slice(0, 7) : ref;
}

function logPoll(ref: string, elapsedSec: number, status: string): void {
  log.debug('poll', {
    tool: 'ci_wait_run',
    ref: shortRef(ref),
    elapsed_sec: elapsedSec,
    status,
  });
}

/** Snapshot we pass between phases. Slice of NormalizedCiRun + normalized status. */
export interface RunSnapshot {
  run_id: number;
  workflow_name: string;
  /** Platform-normalized: `completed` | `in_progress` | raw-other. */
  status: string;
  /** Normalized conclusion or null when still running. */
  conclusion: string | null;
  url: string;
  sha: string;
}

// GitLab pipeline status values normalize to the same vocabulary the handler
// used internally. Lifted verbatim.
function normalizeGitlabStatus(status: string): {
  status: string;
  conclusion: string | null;
} {
  switch (status) {
    case 'success':
      return { status: 'completed', conclusion: 'success' };
    case 'failed':
      return { status: 'completed', conclusion: 'failure' };
    case 'canceled':
    case 'cancelled':
      return { status: 'completed', conclusion: 'cancelled' };
    case 'skipped':
      // Treat skipped as success — there's nothing to wait on.
      return { status: 'completed', conclusion: 'success' };
    case 'running':
    case 'pending':
    case 'preparing':
    case 'waiting_for_resource':
    case 'created':
    case 'scheduled':
    case 'manual':
      return { status: 'in_progress', conclusion: null };
    default:
      return { status, conclusion: null };
  }
}

function snapshotFromRun(
  run: NormalizedCiRun,
  platform: 'github' | 'gitlab',
): RunSnapshot {
  if (platform === 'github') {
    return {
      run_id: run.run_id,
      workflow_name: run.workflow_name,
      status: run.status,
      conclusion: run.conclusion,
      url: run.url,
      sha: run.head_sha,
    };
  }
  const normalized = normalizeGitlabStatus(run.status);
  return {
    run_id: run.run_id,
    workflow_name: run.workflow_name,
    status: normalized.status,
    conclusion: normalized.conclusion,
    url: run.url,
    sha: run.head_sha,
  };
}

function pickRun(
  runs: NormalizedCiRun[],
  workflowName: string | undefined,
  platform: 'github' | 'gitlab',
): NormalizedCiRun | null {
  if (runs.length === 0) return null;
  const filtered = workflowName
    ? runs.filter((r) =>
        platform === 'github'
          ? r.workflow_name === workflowName
          : r.workflow_name === workflowName,
      )
    : runs;
  if (filtered.length === 0) return null;
  // Prefer the newest run when multiple match. List output is already reverse-
  // chronological; be explicit so tests don't depend on that.
  const sorted = [...filtered].sort((a, b) => {
    const at = a.created_at ? Date.parse(a.created_at) : 0;
    const bt = b.created_at ? Date.parse(b.created_at) : 0;
    return bt - at;
  });
  return sorted[0];
}

// GitHub conclusions: success, failure, cancelled, timed_out, action_required,
// neutral, skipped, stale — normalize to FinalStatus.
function normalizeConclusion(
  conclusion: string | null,
): FinalStatus | 'unknown' {
  if (!conclusion) return 'unknown';
  switch (conclusion) {
    case 'success':
    case 'skipped':
    case 'neutral':
      return 'success';
    case 'failure':
    case 'timed_out':
    case 'action_required':
    case 'stale':
      return 'failure';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    default:
      return 'unknown';
  }
}

async function listRuns(
  deps: WaitDeps,
  args: CiListRunsArgs,
): Promise<NormalizedCiRun[]> {
  const result = await deps.adapter.ciListRuns(args);
  if ('platform_unsupported' in result) {
    throw new Error(`ciListRuns platform_unsupported: ${result.hint}`);
  }
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

async function resolveBranch(
  deps: WaitDeps,
  args: ResolveBranchShaArgs,
): Promise<string | null> {
  const result = await deps.adapter.resolveBranchSha(args);
  if ('platform_unsupported' in result) return null;
  if (!result.ok) return null;
  return result.data ? result.data.sha : null;
}

/**
 * Phase 0: GitHub-only merge-queue pre-flight.
 *
 * Returns a terminal `WaitResult` when the merge-queue path is hit
 * (either `merge_group_validated` success or the structured
 * `not_applicable` error); returns `null` to fall through to Phase 1.
 */
async function mergeQueuePreflight(
  args: WaitArgs,
  deps: WaitDeps,
  expectedSha: string | undefined,
  elapsedSec: () => number,
): Promise<WaitResult | null> {
  if (args.platform !== 'github') return null;

  const initialRuns = await listRuns(deps, {
    ref: args.ref,
    workflow_name: args.workflow_name,
    repo: args.repo,
    expected_sha: expectedSha,
    limit: LIST_LIMIT,
  });
  if (initialRuns.length === 0) return null;

  const anyPush = initialRuns.some((r) => r.event === 'push');
  if (anyPush) return null;

  // No push-triggered runs. Resolve head SHA to compare against merge_group
  // runs. When expected_sha is set, that IS the head SHA; when ref is itself
  // a SHA, use it directly.
  let headSha: string | null =
    expectedSha ?? (isSha(args.ref) ? args.ref.toLowerCase() : null);
  if (!headSha) {
    const slug = args.repo ?? args.cwd_repo_slug ?? undefined;
    if (slug) {
      headSha = await resolveBranch(deps, { branch: args.ref, repo: slug });
      if (headSha) headSha = headSha.toLowerCase();
    }
  }

  const mergeGroupMatch = initialRuns.find(
    (r) =>
      r.event === 'merge_group' &&
      headSha !== null &&
      r.head_sha?.toLowerCase() === headSha,
  );
  if (mergeGroupMatch) {
    return {
      ok: true,
      final_status: 'not_applicable',
      reason: 'merge_group_validated',
      run_id: mergeGroupMatch.run_id,
      workflow_name: mergeGroupMatch.workflow_name,
      url: mergeGroupMatch.url,
      ref: args.ref,
      sha: mergeGroupMatch.head_sha,
      waited_sec: 0,
    };
  }

  // No push-triggered runs and no matching merge_group run. Structured
  // `not_applicable` error — distinguishable from a real CI failure.
  return {
    ok: false,
    final_status: 'not_applicable',
    error: `ref '${args.ref}' has no push-triggered workflows and no matching merge_group run found`,
    ref: args.ref,
    waited_sec: elapsedSec(),
  };
}

async function fetchSnapshot(
  args: WaitArgs,
  deps: WaitDeps,
  expectedSha: string | undefined,
): Promise<RunSnapshot | null> {
  const runs = await listRuns(deps, {
    ref: args.ref,
    workflow_name: args.workflow_name,
    repo: args.repo,
    expected_sha: expectedSha,
    limit: LIST_LIMIT,
  });
  // Defense-in-depth: drop runs whose head_sha doesn't match expected_sha.
  // Covers server-side filter quirks that let non-matching runs slip through.
  const filtered = expectedSha
    ? runs.filter((r) => r.head_sha?.toLowerCase() === expectedSha.toLowerCase())
    : runs;
  const picked = pickRun(filtered, args.workflow_name, args.platform);
  return picked ? snapshotFromRun(picked, args.platform) : null;
}

/** The full `ci_wait_run` state machine. Handler is a thin dispatcher around this. */
export async function waitForRun(
  args: WaitArgs,
  deps: WaitDeps,
): Promise<WaitResult> {
  const requestedInterval = args.poll_interval_sec ?? DEFAULT_POLL_INTERVAL_SEC;
  const pollIntervalSec = Math.max(requestedInterval, MIN_POLL_INTERVAL_SEC);
  const timeoutSec = args.timeout_sec ?? DEFAULT_TIMEOUT_SEC;
  const expectedSha = args.expected_sha?.toLowerCase();
  const noRunYetWindowSec = expectedSha ? timeoutSec : NO_RUN_YET_WINDOW_SEC;

  const startMs = deps.now();
  const elapsedSec = (): number => Math.floor((deps.now() - startMs) / 1000);

  try {
    // --- Phase 0 (GitHub only): merge-queue pre-flight ---
    const preflight = await mergeQueuePreflight(
      args,
      deps,
      expectedSha,
      elapsedSec,
    );
    if (preflight) return preflight;

    // --- Phase 1: wait for a run to appear (no-run-yet window) ---
    let snapshot: RunSnapshot | null = null;
    while (elapsedSec() < noRunYetWindowSec) {
      snapshot = await fetchSnapshot(args, deps, expectedSha);
      if (snapshot) break;
      logPoll(args.ref, elapsedSec(), 'no_run_yet');
      if (elapsedSec() >= timeoutSec) break;
      const sleepSec = expectedSha ? pollIntervalSec : NO_RUN_YET_POLL_SEC;
      await deps.sleep(sleepSec * 1000);
    }

    if (!snapshot) {
      const waited = elapsedSec();
      const filterMsg = args.workflow_name
        ? ` (filtered by workflow_name='${args.workflow_name}')`
        : '';
      const shaMsg = expectedSha ? ` with head SHA '${expectedSha}'` : '';
      return {
        ok: false,
        error:
          `No CI run found for ref '${args.ref}'${shaMsg}${filterMsg} after waiting ${waited}s. ` +
          `The pipeline may not have been triggered, or the ref has not been pushed to origin. ` +
          `Verify with: gh run list --${isSha(args.ref) ? 'commit' : 'branch'} ${args.ref}`,
        waited_sec: waited,
        ref: args.ref,
        platform: args.platform,
        ...(expectedSha ? { expected_sha: expectedSha } : {}),
      };
    }

    // --- Phase 2: poll the run until it completes or we time out ---
    logPoll(args.ref, elapsedSec(), snapshot.status);

    while (snapshot.status !== 'completed') {
      if (elapsedSec() >= timeoutSec) {
        return {
          ok: true,
          run_id: snapshot.run_id,
          workflow_name: snapshot.workflow_name,
          final_status: 'timed_out',
          url: snapshot.url,
          ref: args.ref,
          sha: snapshot.sha,
          waited_sec: elapsedSec(),
          message:
            `ci_wait_run hit timeout_sec=${timeoutSec} while run was still '${snapshot.status}'. ` +
            `The run is still executing on the server — check ${snapshot.url}.`,
        };
      }
      await deps.sleep(pollIntervalSec * 1000);
      const next = await fetchSnapshot(args, deps, expectedSha);
      if (!next) {
        logPoll(args.ref, elapsedSec(), `${snapshot.status}(stale,no_run_returned)`);
        continue;
      }
      snapshot = next;
      logPoll(args.ref, elapsedSec(), snapshot.status);
    }

    // --- Phase 3: completed — map conclusion to final_status ---
    const finalStatus = normalizeConclusion(snapshot.conclusion);
    if (finalStatus === 'unknown') {
      return {
        ok: false,
        error:
          `Run completed with unrecognized conclusion '${snapshot.conclusion ?? 'null'}'. ` +
          `run_id=${snapshot.run_id} url=${snapshot.url}`,
        run_id: snapshot.run_id,
        workflow_name: snapshot.workflow_name,
        url: snapshot.url,
        ref: args.ref,
        sha: snapshot.sha,
        waited_sec: elapsedSec(),
      };
    }

    return {
      ok: true,
      run_id: snapshot.run_id,
      workflow_name: snapshot.workflow_name,
      final_status: finalStatus,
      url: snapshot.url,
      ref: args.ref,
      sha: snapshot.sha,
      waited_sec: elapsedSec(),
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error,
      ref: args.ref,
      platform: args.platform,
      waited_sec: elapsedSec(),
    };
  }
}

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
