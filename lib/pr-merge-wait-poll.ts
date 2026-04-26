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

export interface PollDeps {
  fetchState: () => Promise<PrStateInfo>;
  intervalMs: number;
  timeoutMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
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
): Promise<PollSuccess | PollTimeout | PollFetchError> {
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
