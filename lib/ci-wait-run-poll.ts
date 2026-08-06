/**
 * Platform-agnostic polling loop for `ci_wait_run`
 * (Story 2.19, #313).
 *
 * Lifted out of `handlers/ci_wait_run.ts` so the phased state machine isn't
 * duplicated per platform — same architectural rule as `lib/pr-wait-ci-poll.ts`
 * and `lib/pr-merge-wait-poll.ts`. Every subprocess touch goes through the
 * routed `getAdapter()` (via the `ciListRuns` + `resolveBranchSha` sub-calls),
 * so this module remains free of `gh`/`glab` invocations and platform
 * branching.
 *
 * Phases:
 * - Phase 1: wait for a run to APPEAR (no-run-yet window). The window depends on
 *   the caller (#483): `require_merge_result` → full `timeout_sec` (merged-results
 *   pipelines are created async and can take minutes to appear); `expected_sha` →
 *   bounded `min(timeout_sec, FIRST_RUN_APPEARANCE_SEC)` (a branch pipeline appears
 *   near-instantly, so a longer wait is silent hanging, not patience); neither →
 *   a 60s floor.
 * - Phase 2: poll the run (once it has appeared) until it completes or we hit the
 *   FULL `timeout_sec` — the appearance bound never caps completion.
 * - Phase 3: completed — map conclusion to `final_status`.
 *
 * Injectable `now`/`sleep` makes tests instant. The adapter object is
 * injectable too (`deps.adapter`) so tests can drive it directly without
 * going through `getAdapter()`.
 *
 * ## `require_merge_result` — the wave trust gate's contract (#476, #452)
 *
 * The gate is specified to grade the **merge result** (the pipeline run against
 * the result of merging source into target), never the source branch HEAD. It
 * had no way to tell those apart, so it accepted whichever run it happened to
 * find. Three ways that silently graded the wrong commit:
 *
 *   1. GitLab merged-results pipelines disabled → only a branch pipeline exists.
 *   2. A `.gitlab-ci.yml` that admits no merge-request pipelines → same.
 *   3. Conflicting branches → GitLab silently falls back to a branch pipeline.
 *
 * And worst: a GitLab merge commit's branch pipeline is `skipped`, which this
 * module mapped to `conclusion: 'success'` — so the gate could return **success
 * for a pipeline that never ran**.
 *
 * With `require_merge_result: true` the wait only ever grades a merge-result
 * run, and returns the structured `not_merge_result` failure when it cannot get
 * one. It is conservative by construction: it can HOLD a wave that should have
 * passed, but it can never PASS a wave on a pipeline that did not validate the
 * merge. Callers that legitimately watch a branch pipeline (e.g. the post-merge
 * `ci_wait_run(ref: 'main')` in /mmr) leave it off and are unaffected.
 */

import { describeEmptyResult } from './shared/query-outcome.js';
import type {
  CiListRunsArgs,
  MergeAnchor,
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
// Bounded first-appearance window for the expected_sha-only path (#483). After a
// push the branch pipeline is created near-instantly; this buys margin for a
// backed-up runner without approaching the full-timeout silence. Phase 2 (a run
// that has appeared, polled to completion) is NOT bounded by this.
export const FIRST_RUN_APPEARANCE_SEC = 180;
export const LIST_LIMIT = 20;

export type FinalStatus =
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'timed_out'
  | 'not_applicable'
  /**
   * The run available for this ref is NOT a merge-result run, and the caller
   * required one (#476). Never a pass — the gate must HOLD rather than grade a
   * branch pipeline as if it validated the merge.
   */
  | 'not_merge_result';

export interface WaitArgs {
  ref: string;
  workflow_name?: string;
  poll_interval_sec?: number;
  timeout_sec?: number;
  repo?: string;
  expected_sha?: string;
  platform: 'github' | 'gitlab';
  /**
   * Only accept a MERGE-RESULT run (#476). GitHub: a `pull_request` run
   * (evaluated against `refs/pull/N/merge`). GitLab: a `merge_request_event`
   * pipeline (a merged-results pipeline). Anything else — including a green
   * branch pipeline — yields `final_status: 'not_merge_result'`.
   *
   * Defaults to `false` so existing callers that legitimately watch a branch
   * pipeline are unchanged. The wave trust gate passes `true`.
   */
  require_merge_result?: boolean;
  /**
   * PR (GitHub) / MR iid (GitLab). REQUIRED alongside `require_merge_result`:
   * it is what lets us prove the run we grade belongs to the CURRENT head.
   * Filtering to merge-result runs is necessary but not sufficient — a GREEN
   * merge-result run for a PREVIOUS commit is still sitting in the list.
   */
  pr_number?: number;
}

export interface WaitDeps {
  adapter: Pick<
    PlatformAdapter,
    'ciListRuns' | 'resolveBranchSha' | 'resolveMergeAnchor'
  >;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export type WaitResult =
  | {
      ok: true;
      final_status: FinalStatus;
      /** Machine-readable qualifier for a non-graded terminal state. */
      reason?: 'not_merge_result';
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
      /** Machine-readable qualifier for a structured (non-CI) failure. */
      reason?: 'not_merge_result';
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

/**
 * GitLab merged-results pipelines live on `refs/merge-requests/<iid>/merge`.
 *
 * VERIFIED against live GitLab (analogicdev, 2026-07-13) — across real projects,
 * `source == "merge_request_event"` covers THREE distinct ref shapes:
 *
 *   refs/merge-requests/N/merge   146x  merged-results — validates the MERGE   <-- the only one we want
 *   refs/merge-requests/N/train    74x  merge-train pipeline
 *   refs/merge-requests/N/head     27x  DETACHED — validates the BRANCH HEAD   <-- must NOT satisfy the gate
 *
 * So `source` alone does NOT discriminate. A detached pipeline is exactly the
 * false-pass #476 exists to prevent: it is green, it is a `merge_request_event`,
 * and it never looked at the merge. The ref suffix is the discriminator.
 */
const GITLAB_MERGE_RESULT_REF = /^refs\/merge-requests\/\d+\/merge$/;

/**
 * Is this run a MERGE-RESULT run — i.e. did CI evaluate the result of merging the
 * source into the target, rather than the source branch HEAD? (#476)
 *
 * - GitLab: the pipeline's ref must be `refs/merge-requests/<iid>/merge`. The
 *   adapter maps `pipeline.ref` onto `head_branch`. (`merge_group` is not
 *   considered on either platform: the fleet is queue-less.)
 * - GitHub: a `pull_request` run is checked out at `refs/pull/N/merge` — the
 *   merge result. A `push` run is the branch HEAD.
 */
export function isMergeResultRun(
  run: NormalizedCiRun,
  platform: 'github' | 'gitlab',
): boolean {
  if (platform === 'gitlab') {
    return (
      run.event === 'merge_request_event' &&
      GITLAB_MERGE_RESULT_REF.test(run.head_branch ?? '')
    );
  }
  return run.event === 'pull_request';
}

/**
 * A run that validated nothing. Never a pass under `require_merge_result`.
 *
 * - GitLab: `status: 'skipped'` — and note `normalizeGitlabStatus` maps that to
 *   conclusion `success`, which is how the gate could return success for a
 *   pipeline that never ran.
 * - GitHub: `conclusion: 'skipped' | 'neutral'` (every job gated off by `if:`),
 *   which `normalizeConclusion` likewise folds into `success`.
 */
function validatedNothing(run: NormalizedCiRun): boolean {
  if (run.status === 'skipped') return true;
  const c = run.conclusion?.toLowerCase();
  return c === 'skipped' || c === 'neutral';
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

/**
 * The argv of the most recent lookup, captured so the "found nothing" message
 * can derive its verify line from the query that ACTUALLY ran (#492/#493).
 *
 * Module-scoped rather than threaded through every call site: the poll loop
 * calls listRuns from several places and the message needs whichever ran last,
 * which is exactly "the query whose emptiness we are reporting".
 */
let lastArgv: string[] | undefined;

async function listRuns(
  deps: WaitDeps,
  args: CiListRunsArgs,
): Promise<NormalizedCiRun[]> {
  const result = await deps.adapter.ciListRuns(args);
  if ('platform_unsupported' in result) {
    throw new Error(`ciListRuns platform_unsupported: ${result.hint}`);
  }
  if (!result.ok) {
    lastArgv = result.queried_argv;
    throw new Error(result.error);
  }
  lastArgv = result.queried_argv;
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

/** What `fetchSnapshot` found. Distinguishes "nothing yet" from "wrong kind". */
type Fetched =
  | { kind: 'run'; snapshot: RunSnapshot }
  | { kind: 'none' }
  /** Runs exist, but none is a merge-result run and the caller demanded one. */
  | { kind: 'not_merge_result'; sawBranchRun: boolean; skippedOnly: boolean }
  /**
   * A merge-result run exists but is STALE — a newer branch run proves the
   * current HEAD's merge-result pipeline has not been created yet. Grading the
   * stale one would pass the gate on code CI never saw.
   */
  | { kind: 'awaiting_fresh_merge_result' };

/** Same head? Field-wise, so a platform mismatch can never read as equal. */
function anchorsEqual(a: MergeAnchor, b: MergeAnchor): boolean {
  return a.head_sha === b.head_sha && a.head_pipeline_id === b.head_pipeline_id;
}

/** Does this run belong to the commit the PR/MR currently points at? */
function matchesAnchor(
  run: NormalizedCiRun,
  anchor: MergeAnchor,
  platform: 'github' | 'gitlab',
): boolean {
  if (platform === 'gitlab') {
    // A merged-results pipeline's sha is the ephemeral merge commit, so a SHA
    // match is impossible by construction. GitLab publishes `head_pipeline` —
    // its own statement of which pipeline is current for the MR head.
    return (
      anchor.head_pipeline_id !== undefined &&
      run.run_id === anchor.head_pipeline_id
    );
  }
  // GitHub: a pull_request run's head_sha IS the PR head SHA (verified live).
  return (
    anchor.head_sha !== undefined &&
    run.head_sha?.toLowerCase() === anchor.head_sha.toLowerCase()
  );
}

async function fetchSnapshot(
  args: WaitArgs,
  deps: WaitDeps,
  expectedSha: string | undefined,
  anchor: MergeAnchor,
): Promise<Fetched> {
  const runs = await listRuns(deps, {
    ref: args.ref,
    workflow_name: args.workflow_name,
    repo: args.repo,
    // A merge-result run's head_sha is the EPHEMERAL MERGE COMMIT, never the
    // branch HEAD — so an expected_sha filter would discard exactly the run we
    // are looking for. Don't send it when a merge result is required (#452).
    expected_sha: args.require_merge_result ? undefined : expectedSha,
    limit: LIST_LIMIT,
  });

  if (args.require_merge_result) {
    if (runs.length === 0) return { kind: 'none' };

    const mergeResults = runs
      .filter((r) => isMergeResultRun(r, args.platform))
      .filter((r) => !validatedNothing(r));

    if (mergeResults.length === 0) {
      // Runs exist for this ref, but none of them validated the merge. Never
      // grade a branch pipeline (or a skipped one) in its place — that is the
      // silent false-pass #476 exists to kill.
      return {
        kind: 'not_merge_result',
        sawBranchRun: runs.some((r) => r.event === 'push'),
        skippedOnly: runs.every(validatedNothing),
      };
    }

    // POSITIVE FRESHNESS ANCHOR (#476).
    //
    // Filtering to merge-result runs is necessary but NOT sufficient. Nothing in
    // a run list binds a run to the CURRENT head: push commit A (green), push
    // commit B, and B's merge-result run may not exist yet — the newest one in
    // the list is still A's GREEN run. Grading it merges code CI never saw.
    //
    // An earlier attempt used a NEGATIVE heuristic ("hold if a branch run is
    // newer"). It fails OPEN: it only fires when a sibling push run exists, and
    // the two commonest configurations produce none — GitHub `on: pull_request`
    // -only workflows, and GitLab's own recommended dedup rule. Absence of
    // evidence is not proof of freshness.
    //
    // So: freshness must be PROVEN, per platform, against the PR/MR itself.
    const anchored = mergeResults.filter((r) => matchesAnchor(r, anchor, args.platform));
    if (anchored.length === 0) {
      // Merge-result runs exist, but none belongs to the current head. The run
      // for HEAD has not been created yet (or CI is misconfigured). HOLD.
      return { kind: 'awaiting_fresh_merge_result' };
    }

    const picked = pickRun(anchored, args.workflow_name, args.platform);
    if (!picked) return { kind: 'awaiting_fresh_merge_result' };

    return { kind: 'run', snapshot: snapshotFromRun(picked, args.platform) };
  }

  // Defense-in-depth: drop runs whose head_sha doesn't match expected_sha.
  // Covers server-side filter quirks that let non-matching runs slip through.
  const filtered = expectedSha
    ? runs.filter((r) => r.head_sha?.toLowerCase() === expectedSha.toLowerCase())
    : runs;
  const picked = pickRun(filtered, args.workflow_name, args.platform);
  return picked
    ? { kind: 'run', snapshot: snapshotFromRun(picked, args.platform) }
    : { kind: 'none' };
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
  // Phase-1 "no run has appeared yet" window. The THREE callers want three things,
  // and collapsing them is the #483 bug:
  //
  //   require_merge_result → FULL timeout. A GitLab merged-results pipeline
  //     (refs/merge-requests/N/merge) is created ASYNCHRONOUSLY after the MR
  //     updates and routinely takes minutes to even appear; a short window here is
  //     #452 in reverse (every wave HOLDs spuriously).
  //
  //   expected_sha (only) → BOUNDED (#483). This is the /scpmmr post-merge branch
  //     wait: after a push the branch pipeline is created near-instantly, so if it
  //     has not appeared in a few minutes it is not coming. Coupling this to the
  //     full timeout meant a transient first-poll miss spun SILENTLY for the whole
  //     30-minute ceiling (wintermute, blueshift #100/#101). Bound it so a miss
  //     fails fast with an actionable message. Phase 2 (polling a run that HAS
  //     appeared) still uses the full timeout — only first-appearance is bounded.
  //
  //   neither → the original 60s fail-fast floor.
  const noRunYetWindowSec = args.require_merge_result
    ? timeoutSec
    : expectedSha
      ? Math.min(timeoutSec, FIRST_RUN_APPEARANCE_SEC)
      : NO_RUN_YET_WINDOW_SEC;

  const startMs = deps.now();
  const elapsedSec = (): number => Math.floor((deps.now() - startMs) / 1000);

  try {
    // --- Phase 0: resolve the freshness anchor (require_merge_result only) ---
    // Fail CLOSED. If we cannot prove which run belongs to the current head, we
    // must not grade any run at all — that is the whole point of #476.
    let anchor: MergeAnchor = {};
    if (args.require_merge_result) {
      if (args.pr_number === undefined) {
        return {
          ok: false,
          final_status: 'not_merge_result',
          reason: 'not_merge_result',
          error:
            `require_merge_result needs pr_number: without the PR/MR number there is no way to prove the ` +
            `merge-result run belongs to the CURRENT head. A green merge-result run for a PREVIOUS commit ` +
            `would otherwise satisfy the gate.`,
          ref: args.ref,
          waited_sec: 0,
          platform: args.platform,
        };
      }
      const res = await deps.adapter.resolveMergeAnchor({
        number: args.pr_number,
        repo: args.repo,
      });
      if ('platform_unsupported' in res || !res.ok) {
        const why = 'platform_unsupported' in res ? res.hint : res.error;
        return {
          ok: false,
          final_status: 'not_merge_result',
          reason: 'not_merge_result',
          error: `could not resolve the merge-result freshness anchor for #${args.pr_number}: ${why}`,
          ref: args.ref,
          waited_sec: elapsedSec(),
          platform: args.platform,
        };
      }
      anchor = res.data;
    }

    // --- Phase 1: wait for a run to appear (no-run-yet window) ---
    let snapshot: RunSnapshot | null = null;
    let wrongKind: Extract<Fetched, { kind: 'not_merge_result' }> | null = null;
    let sawStale = false;

    while (elapsedSec() < noRunYetWindowSec) {
      const fetched = await fetchSnapshot(args, deps, expectedSha, anchor);
      if (fetched.kind === 'run') {
        snapshot = fetched.snapshot;
        wrongKind = null;
        break;
      }
      if (fetched.kind === 'awaiting_fresh_merge_result') {
        // Merge-result runs exist but none belongs to the current head. Do NOT
        // grade the stale one. Remember it, so an expired window terminates as a
        // classified `not_merge_result` rather than a generic "no run found".
        sawStale = true;
        logPoll(args.ref, elapsedSec(), 'awaiting_fresh_merge_result');
      } else if (fetched.kind === 'not_merge_result') {
        // Keep waiting — the merge-result pipeline may not have been created
        // yet (GitLab creates it a beat after the branch pipeline). But REMEMBER
        // that we only ever saw the wrong kind, so that if the window expires we
        // fail as `not_merge_result` rather than as a generic "no run found".
        wrongKind = fetched;
        logPoll(args.ref, elapsedSec(), 'awaiting_merge_result');
      } else {
        logPoll(args.ref, elapsedSec(), 'no_run_yet');
      }
      if (elapsedSec() >= timeoutSec) break;
      // The fast 5s probe is only for the bare 60s no-args window (cheap: ≤12
      // calls). The expected_sha (bounded, #483) and require_merge_result (full
      // timeout) windows poll at the normal interval so a long wait does not cost
      // hundreds of API calls.
      const sleepSec =
        expectedSha || args.require_merge_result ? pollIntervalSec : NO_RUN_YET_POLL_SEC;
      await deps.sleep(sleepSec * 1000);
    }

    // Runs exist for this ref, but not one that validates the merge. This is a
    // conservative HARD FAIL, never a pass: grading a branch pipeline as though
    // it validated the merge is the exact silent false-pass #476 exists to kill.
    if (!snapshot && sawStale && !wrongKind) {
      const waited = elapsedSec();
      return {
        ok: false,
        final_status: 'not_merge_result',
        reason: 'not_merge_result',
        error:
          `ci_wait_run found merge-result run(s) for ref '${args.ref}', but none belongs to the CURRENT head of ` +
          `#${String(args.pr_number)} after waiting ${waited}s. Refusing to grade a run for a previous commit — ` +
          `that would pass the gate on code CI never saw. The head's pipeline may still be pending, or CI may not ` +
          `produce one for it.`,
        waited_sec: waited,
        ref: args.ref,
        platform: args.platform,
      };
    }

    if (!snapshot && wrongKind) {
      const waited = elapsedSec();
      // Three distinct causes → three distinct messages. `sawBranchRun` exists to
      // tell the detached-pipeline case apart from the branch-pipeline case: a
      // /head pipeline has event=merge_request_event, NOT push, so calling it a
      // "branch pipeline" would send the operator chasing the wrong config.
      const why = wrongKind.skippedOnly
        ? `the only run(s) for this ref were SKIPPED — nothing was actually validated`
        : wrongKind.sawBranchRun
          ? `the only run(s) for this ref are branch pipelines (CI against the branch HEAD), not the merge result`
          : `the only merge-request run(s) for this ref are DETACHED or merge-train pipelines — a detached pipeline validates the source branch HEAD, not the merge result`;
      const hint =
        args.platform === 'gitlab'
          ? `Verify the project has merged-results pipelines enabled (merge_pipelines_enabled) AND that .gitlab-ci.yml admits merge-request pipelines ($CI_PIPELINE_SOURCE == "merge_request_event"). Note GitLab silently falls back to a branch pipeline when the branches conflict.`
          : `Verify a workflow is triggered on 'pull_request' for this branch — a 'push'-triggered run evaluates the branch HEAD, not refs/pull/N/merge.`;
      return {
        ok: false,
        final_status: 'not_merge_result',
        reason: 'not_merge_result',
        error:
          `ci_wait_run required a MERGE-RESULT run for ref '${args.ref}', but ${why}. ` +
          `Refusing to report success on a run that did not validate the merge. ${hint}`,
        waited_sec: waited,
        ref: args.ref,
        platform: args.platform,
      };
    }

    if (!snapshot) {
      const waited = elapsedSec();
      const filterMsg = args.workflow_name
        ? ` (filtered by workflow_name='${args.workflow_name}')`
        : '';
      const shaMsg = expectedSha ? ` with head SHA '${expectedSha}'` : '';
      return {
        ok: false,
        // OBSERVATION, NOT CAUSE (#492/#493). This previously asserted "the
        // pipeline may not have been triggered" — a hypothesis about the world
        // the tool has no evidence for; it cannot distinguish "did not run"
        // from "I looked in the wrong place", and on the reported repro the run
        // existed and had already SUCCEEDED.
        //
        // Worse, the old verify line rendered the exact failing lookup, so an
        // operator who followed it got an empty result that appeared to confirm
        // the false cause. The command is now derived from the argv actually
        // executed, so it cannot disagree with the query that was run, and the
        // guesses are labelled as unverified.
        error: describeEmptyResult({
          what: 'CI run',
          detail: `for ref '${args.ref}'${shaMsg}${filterMsg} after waiting ${waited}s`,
          argv: lastArgv ?? [],
          hypotheses: [
            'the pipeline was not triggered',
            'the ref has not been pushed to origin',
            'the run exists under a different ref spelling',
          ],
        }),
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
      const refetched = await fetchSnapshot(args, deps, expectedSha, anchor);
      const next = refetched.kind === 'run' ? refetched.snapshot : null;
      if (!next) {
        logPoll(args.ref, elapsedSec(), `${snapshot.status}(stale,no_run_returned)`);
        continue;
      }
      snapshot = next;
      logPoll(args.ref, elapsedSec(), snapshot.status);
    }

    // --- Phase 2.5: RE-VALIDATE THE ANCHOR before grading (TOCTOU) ---
    //
    // The anchor was resolved at t=0 and we may have polled for up to timeout_sec
    // (default 1800s). If the PR/MR head MOVED during the wait, the anchor now
    // names the OLD head — and the run we are about to grade validated that old
    // head, not what is about to be merged. That is the #476 bug re-entering
    // through the back door. Re-resolve and HOLD if it changed.
    if (args.require_merge_result && args.pr_number !== undefined) {
      const recheck = await deps.adapter.resolveMergeAnchor({
        number: args.pr_number,
        repo: args.repo,
      });
      if ('platform_unsupported' in recheck || !recheck.ok) {
        return {
          ok: false,
          final_status: 'not_merge_result',
          reason: 'not_merge_result',
          error: `could not re-confirm the freshness anchor for #${args.pr_number} before grading — refusing to grade`,
          ref: args.ref,
          waited_sec: elapsedSec(),
          platform: args.platform,
        };
      }
      if (!anchorsEqual(anchor, recheck.data)) {
        return {
          ok: false,
          final_status: 'not_merge_result',
          reason: 'not_merge_result',
          error:
            `#${args.pr_number} moved while ci_wait_run was waiting: the run that completed validated the PREVIOUS ` +
            `head, not the current one. Refusing to grade it — that would pass the gate on code CI never saw.`,
          ref: args.ref,
          waited_sec: elapsedSec(),
          platform: args.platform,
        };
      }
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