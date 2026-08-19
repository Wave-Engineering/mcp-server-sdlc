/**
 * Platform-agnostic polling loop for `pr_merge_wait` (Story 1.11, #248).
 *
 * Lifted out of `handlers/pr_merge_wait.ts` so the loop isn't duplicated per
 * platform — same architectural rule as `lib/pr-wait-ci-poll.ts`. Both
 * `lib/adapters/pr-merge-wait-github.ts` and `pr-merge-wait-gitlab.ts` import
 * `pollUntilMerged` and call it with their own state-fetcher.
 *
 * The state fetcher itself goes through the platform adapter
 * (`getAdapter().fetchPrState(...)`), so this module remains free of
 * subprocess work and platform branching.
 *
 * **Async fetcher contract.** `fetchState` is `() => Promise<PrStateInfo>` —
 * one step looser than the pre-Story-1.11 sync contract — because the routed
 * `getAdapter().fetchPrState(...)` call is async by design (every adapter
 * method returns a Promise). Sync helpers (e.g., `fetchPrStateGithubSync`)
 * still exist and are wrapped trivially (`async () => fetchSync(...)`).
 */

import type { PrStateInfo } from './adapters/types.js';

export type { PrStateInfo };

/**
 * #524: the verdict a `checkTerminal` hook returns when an enrolled merge has
 * reached a state it will never leave by waiting (a failed/canceled pipeline,
 * or a fresh non-transient block). `reason` is surfaced verbatim in the
 * caller's error so the failure names its actual cause.
 */
export interface TerminalInfo {
  reason: string;
}

export interface PollDeps {
  fetchState: () => Promise<PrStateInfo>;
  intervalMs: number;
  timeoutMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  // #524: optional platform-aware terminal-state hook, consulted each iteration
  // (after the merged check, before the timeout check). A non-null return stops
  // the poll immediately with a `terminal` result instead of burning the rest
  // of the timeout on an enrolled merge that can no longer land. The loop stays
  // platform-agnostic — it only sees an opaque probe; the GitLab wait wrapper
  // supplies the classification. GitHub supplies none (its queue path has its
  // own terminal handling), so the loop behaves exactly as before there.
  checkTerminal?: () => Promise<TerminalInfo | null>;
}

export interface PollSuccess {
  ok: true;
  state: PrStateInfo;
  elapsedMs: number;
}

export interface PollTimeout {
  ok: false;
  reason: 'timeout';
  lastState: PrStateInfo;
  elapsedMs: number;
}

export interface PollFetchError {
  ok: false;
  reason: 'fetch_error';
  error: string;
  lastState: PrStateInfo | null;
  elapsedMs: number;
}

export interface PollTerminal {
  ok: false;
  reason: 'terminal';
  terminal: TerminalInfo;
  lastState: PrStateInfo;
  elapsedMs: number;
}

// Pure poller — no module-level globals, no platform knowledge. Loops:
// fetch → return on merged → check timeout → sleep. The sleep happens AFTER
// the timeout check, so if the budget is already spent we don't waste another
// interval before reporting it. Injectable now/sleep makes tests instant.
//
// fetchState rejections are caught and reported as a `fetch_error` variant so
// the caller can preserve the "PR was already enrolled" context — distinct
// from a clean timeout. Without this distinction, a transient `gh` failure
// mid-poll would surface as a generic outer-catch error and the caller would
// have no idea whether the merge itself failed or just the polling did.
export async function pollUntilMerged(
  deps: PollDeps,
): Promise<PollSuccess | PollTimeout | PollFetchError | PollTerminal> {
  const start = deps.now();
  let lastState: PrStateInfo | null = null;
  while (true) {
    let info: PrStateInfo;
    try {
      info = await deps.fetchState();
    } catch (err) {
      return {
        ok: false,
        reason: 'fetch_error',
        error: err instanceof Error ? err.message : String(err),
        lastState,
        elapsedMs: deps.now() - start,
      };
    }
    lastState = info;
    const elapsedMs = deps.now() - start;
    if (info.state === 'merged') {
      return { ok: true, state: info, elapsedMs };
    }
    // #524: consult the terminal-state hook before deciding to keep waiting. A
    // failed enrolled pipeline (or a fresh non-transient block) will never
    // resolve to `merged` by polling, so report the real cause promptly rather
    // than timing out. The hook's own read failing is treated as "can't
    // classify, keep polling" — the primary fetchState above stays the ground
    // truth for merged/timeout, so an advisory-probe blip never aborts the wait.
    if (deps.checkTerminal) {
      let verdict: TerminalInfo | null = null;
      try {
        verdict = await deps.checkTerminal();
      } catch {
        verdict = null;
      }
      if (verdict) {
        return { ok: false, reason: 'terminal', terminal: verdict, lastState: info, elapsedMs };
      }
    }
    if (elapsedMs >= deps.timeoutMs) {
      return { ok: false, reason: 'timeout', lastState: info, elapsedMs };
    }
    await deps.sleep(deps.intervalMs);
  }
}

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const DEFAULT_TIMEOUT_SEC = 600;
export const POLL_INTERVAL_MS = 10_000;
