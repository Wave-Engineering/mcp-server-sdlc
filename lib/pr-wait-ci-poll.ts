/**
 * Platform-agnostic polling loop for `pr_wait_ci`.
 *
 * Lifted from `handlers/pr_wait_ci.ts` per Story 1.9 (#246). The retry/poll
 * loop is intentionally a single shared module — both the GitHub and GitLab
 * adapters wrap their own `snapshotFn` and call `runPollLoop` here. Without
 * this extraction, the loop logic (timeout discipline, decide-rule, heartbeat,
 * sleep) would be duplicated per platform; that's the duplication AC item
 * the story explicitly forbids.
 *
 * Architecture:
 *
 *   handler (handlers/pr_wait_ci.ts)
 *     → adapter.prWaitCi(args)              (lib/adapters/pr-wait-ci-{platform}.ts)
 *       → runPollLoop(args, snapshotFn)     (THIS file)
 *         → snapshotFn(number, repo)        (one snapshot per iteration)
 *
 * The adapter returns the FULL `runPollLoop` result; the snapshot function
 * is the only platform-specific thing. The loop owns the timeout, decide,
 * heartbeat, sleep, and logging; everything else is platform-injectable via
 * the `Deps` interface.
 *
 * Preserved-verbatim regressions:
 *  - `decide()` returns `'passed'` when `total > 0 && pending === 0 &&
 *    failed === 0` regardless of `passed === 0` (#221 — docs-only PRs in
 *    repos with conditional CI all-skipped → passed, not deadlock).
 *  - `defaultHeartbeat` swallows all errors silently (best-effort
 *    wave-status integration).
 */

import { execSync } from 'child_process';
import { log } from '../logger.js';

/**
 * `pending` is NOT terminal: this call's `max_wait_sec` budget ran out before CI
 * finished, and the caller re-invokes to keep waiting (#587). It is never a pass.
 */
export type FinalState = 'passed' | 'failed' | 'timed_out' | 'pending';

export const POLL_FLOOR_SEC = 5;

/**
 * The MCP client aborts a tool call that is idle for 1800 s, and an aborted call
 * returns nothing at all (#587). One call's wait is therefore budgeted well under
 * it: the default leaves room for the settle window and a slow snapshot, and the
 * ceiling is the most any caller may ask for.
 */
export const MAX_WAIT_DEFAULT_SEC = 1500;
export const MAX_WAIT_CEILING_SEC = 1700;

/**
 * What is left of a call's `max_wait_sec` once the adapter has spent `spentMs`
 * on its settle window, so the budget bounds the whole call, not just the loop.
 */
export function remainingWaitSec(maxWaitSec: number | undefined, spentMs: number): number | undefined {
  if (maxWaitSec === undefined) return undefined;
  return Math.max(0, maxWaitSec - Math.floor(spentMs / 1000));
}

export interface ChecksSnapshot {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  summary: string;
  url: string;
  /** The pipeline this snapshot graded, when the platform names one (GitLab, #588). */
  graded?: GradedPipeline;
}

export interface GradedPipeline {
  id: number;
  sha: string;
  ref: string;
}

export interface PollArgs {
  number: number;
  poll_interval_sec: number;
  timeout_sec: number;
  /**
   * This call's wall-clock budget (#587). When it runs out before `timeout_sec`
   * and before CI finishes, the loop returns `pending` with `resume: true`
   * instead of a terminal state. Absent: `timeout_sec` alone bounds the call.
   */
  max_wait_sec?: number;
  repo?: string;
}

export interface PollResult {
  ok: true;
  number: number;
  final_state: FinalState;
  checks: { total: number; passed: number; failed: number; pending: number; summary: string };
  waited_sec: number;
  url: string;
  /** The pipeline behind `final_state`, so a caller can check it (#588). */
  graded_pipeline?: GradedPipeline;
  /** Present only with `final_state: 'pending'`: call again with the same args to keep waiting. */
  resume?: true;
}

function pollResult(
  number: number,
  finalState: FinalState,
  snap: ChecksSnapshot,
  waitedSec: number,
): PollResult {
  return {
    ok: true,
    number,
    final_state: finalState,
    checks: {
      total: snap.total,
      passed: snap.passed,
      failed: snap.failed,
      pending: snap.pending,
      summary: snap.summary,
    },
    waited_sec: waitedSec,
    url: snap.url,
    ...(snap.graded !== undefined ? { graded_pipeline: snap.graded } : {}),
    ...(finalState === 'pending' ? { resume: true as const } : {}),
  };
}

// Injection seam for tests — swap sleep + snapshot without touching real time/net.
export interface Deps {
  snapshotFn: (number: number, repo?: string) => ChecksSnapshot | Promise<ChecksSnapshot>;
  sleepFn: (ms: number) => Promise<void>;
  nowFn: () => number;
  /** Optional heartbeat called on each poll iteration for wave-status updates. */
  heartbeatFn?: (number: number, attempt: number, snap: ChecksSnapshot) => void;
}

export function defaultHeartbeat(number: number, attempt: number, snap: ChecksSnapshot): void {
  const detail = `PR #${number} attempt ${attempt}: ${snap.summary}`;
  try {
    execSync(`wave-status waiting-ci '${detail.replace(/'/g, "'\\''")}'`, {
      encoding: 'utf8',
      timeout: 5000,
    });
  } catch {
    // Best-effort — swallow all errors silently.
  }
}

export function decide(snap: ChecksSnapshot): FinalState | null {
  if (snap.failed > 0) return 'failed';
  // No failures + nothing pending → passed, even when `passed === 0` (every
  // check skipped). The previous `passed >= 1` guard deadlocked on PRs whose
  // entire check set was SKIPPED — common for docs-only PRs in repos with
  // conditional CI. See #221.
  if (snap.total > 0 && snap.pending === 0 && snap.failed === 0) return 'passed';
  return null;
}

export function logCycle(number: number, elapsedSec: number, snap: ChecksSnapshot) {
  log.debug('poll', {
    tool: 'pr_wait_ci',
    number,
    elapsed_sec: elapsedSec,
    pending: snap.pending,
    total: snap.total,
    summary: snap.summary,
  });
}

export function defaultDeps(snapshotFn: Deps['snapshotFn']): Deps {
  return {
    snapshotFn,
    sleepFn: (ms: number) => new Promise((r) => setTimeout(r, ms)),
    nowFn: () => Date.now(),
    heartbeatFn: defaultHeartbeat,
  };
}

export async function runPollLoop(args: PollArgs, deps: Deps): Promise<PollResult> {
  const intervalMs = args.poll_interval_sec * 1000;
  const timeoutMs = args.timeout_sec * 1000;
  // #587: whichever runs out first ends this call. When the per-call budget is
  // the tighter one, running out is not a verdict, so the call hands back a
  // resumable `pending`; only the caller's own `timeout_sec` yields `timed_out`.
  const budgetMs = args.max_wait_sec !== undefined ? args.max_wait_sec * 1000 : Infinity;
  const deadlineMs = Math.min(timeoutMs, budgetMs);
  const expired: FinalState = budgetMs < timeoutMs ? 'pending' : 'timed_out';
  const start = deps.nowFn();

  let lastSnap: ChecksSnapshot = {
    total: 0,
    passed: 0,
    failed: 0,
    pending: 0,
    summary: 'no checks observed',
    url: '',
  };

  let attempt = 0;

  // Loop: snapshot → decide → (sleep | return). Timeout is checked after each
  // snapshot AND before each sleep so we can't over-shoot by a full interval.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt++;
    lastSnap = await deps.snapshotFn(args.number, args.repo);
    const elapsedSec = Math.floor((deps.nowFn() - start) / 1000);
    logCycle(args.number, elapsedSec, lastSnap);
    deps.heartbeatFn?.(args.number, attempt, lastSnap);

    const decision = decide(lastSnap);
    if (decision) {
      return pollResult(args.number, decision, lastSnap, elapsedSec);
    }

    if (deps.nowFn() - start >= deadlineMs) {
      return pollResult(
        args.number,
        expired,
        lastSnap,
        Math.floor((deps.nowFn() - start) / 1000),
      );
    }

    // Never sleep past the deadline: a long `poll_interval_sec` would otherwise
    // carry the call beyond its budget and into the client's idle timeout.
    await deps.sleepFn(Math.min(intervalMs, start + deadlineMs - deps.nowFn()));

    // Re-check the deadline after sleep; one last snapshot can still decide.
    if (deps.nowFn() - start >= deadlineMs) {
      lastSnap = await deps.snapshotFn(args.number, args.repo);
      const finalElapsed = Math.floor((deps.nowFn() - start) / 1000);
      logCycle(args.number, finalElapsed, lastSnap);
      return pollResult(args.number, decide(lastSnap) ?? expired, lastSnap, finalElapsed);
    }
  }
}
