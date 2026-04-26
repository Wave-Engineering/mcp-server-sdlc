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

export type FinalState = 'passed' | 'failed' | 'timed_out';

export const POLL_FLOOR_SEC = 5;

export interface ChecksSnapshot {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  summary: string;
  url: string;
}

export interface PollArgs {
  number: number;
  poll_interval_sec: number;
  timeout_sec: number;
  repo?: string;
}

export interface PollResult {
  ok: true;
  number: number;
  final_state: FinalState;
  checks: { total: number; passed: number; failed: number; pending: number; summary: string };
  waited_sec: number;
  url: string;
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
      return {
        ok: true,
        number: args.number,
        final_state: decision,
        checks: {
          total: lastSnap.total,
          passed: lastSnap.passed,
          failed: lastSnap.failed,
          pending: lastSnap.pending,
          summary: lastSnap.summary,
        },
        waited_sec: elapsedSec,
        url: lastSnap.url,
      };
    }

    if (deps.nowFn() - start >= timeoutMs) {
      return {
        ok: true,
        number: args.number,
        final_state: 'timed_out',
        checks: {
          total: lastSnap.total,
          passed: lastSnap.passed,
          failed: lastSnap.failed,
          pending: lastSnap.pending,
          summary: lastSnap.summary,
        },
        waited_sec: Math.floor((deps.nowFn() - start) / 1000),
        url: lastSnap.url,
      };
    }

    await deps.sleepFn(intervalMs);

    // Re-check timeout after sleep in case we slept past the deadline.
    if (deps.nowFn() - start >= timeoutMs) {
      lastSnap = await deps.snapshotFn(args.number, args.repo);
      const finalElapsed = Math.floor((deps.nowFn() - start) / 1000);
      logCycle(args.number, finalElapsed, lastSnap);
      const postDecision = decide(lastSnap);
      return {
        ok: true,
        number: args.number,
        final_state: postDecision ?? 'timed_out',
        checks: {
          total: lastSnap.total,
          passed: lastSnap.passed,
          failed: lastSnap.failed,
          pending: lastSnap.pending,
          summary: lastSnap.summary,
        },
        waited_sec: finalElapsed,
        url: lastSnap.url,
      };
    }
  }
}
