/**
 * GitHub `pr_merge_wait` adapter implementation (Story 1.11, #248).
 *
 * Lifted from `handlers/pr_merge_wait.ts` per the standard PR-family template.
 * The handler is now a thin dispatcher; this module owns the GitHub-specific
 * orchestration: detect-and-skip via `fetchPrState`, call `prMerge`, decide
 * whether to poll, and format the aggregate response.
 *
 * **Architectural rule (Dev Spec §5.5).** Both `pr-merge-wait-github.ts` and
 * `pr-merge-wait-gitlab.ts` import `pollUntilMerged` from
 * `lib/pr-merge-wait-poll.ts` — the loop is platform-agnostic and is NOT
 * duplicated per platform. Both adapters call the shared `executeMergeWait`
 * helper here; the per-platform exports are thin wrappers that pin the
 * `platform` argument so contract-test routing stays honest.
 *
 * **Hybrid sub-call dispatch.** The state fetcher comes from the routed
 * adapter (`getAdapter().fetchPrState(...)`), not a direct import. That keeps
 * cross-platform hybrid sub-calls honest: they go through the same dispatch
 * layer as top-level handler methods.
 */

import {
  pollUntilMerged,
  defaultSleep,
  DEFAULT_TIMEOUT_SEC,
  POLL_INTERVAL_MS,
  type PrStateInfo,
} from '../pr-merge-wait-poll.js';
import { getAdapter } from './index.js';
import type {
  AdapterResult,
  PrMergeWaitArgs,
  PrMergeWaitResponse,
} from './types.js';

// Detect-and-skip synthesizes this aggregate when the PR is already MERGED
// before invocation. We don't know how it was merged historically (direct vs
// queue, this session vs earlier), so report the conservative defaults and
// surface the situation via a warning.
function synthesizeAlreadyMerged(num: number, info: PrStateInfo): PrMergeWaitResponse {
  return {
    number: num,
    enrolled: true,
    merged: true,
    merge_method: 'direct_squash',
    queue: { enabled: false, position: null, enforced: false },
    pr_state: 'MERGED',
    url: info.url,
    merge_commit_sha: info.mergeCommitSha,
    warnings: ['PR was already merged before invocation; pr_merge was not called'],
  };
}

// Pull the PrStateInfo out of an AdapterResult; throws so the caller can fold
// the error into a `fetch_error` poll variant or a top-level adapter failure.
async function fetchStateOrThrow(
  number: number,
  repo: string | undefined,
): Promise<PrStateInfo> {
  const result = await getAdapter({ repo }).fetchPrState({ number, repo });
  if ('platform_unsupported' in result) {
    throw new Error(`fetchPrState platform_unsupported: ${result.hint}`);
  }
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

export interface ExecuteOverrides {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
}

/**
 * Shared executor — both `prMergeWaitGithub` and `prMergeWaitGitlab` delegate
 * here. Platform-agnostic: every subprocess touch goes through `getAdapter()`.
 */
export async function executeMergeWait(
  args: PrMergeWaitArgs,
  overrides?: ExecuteOverrides,
): Promise<AdapterResult<PrMergeWaitResponse>> {
  const timeoutMs = (args.timeout_sec ?? DEFAULT_TIMEOUT_SEC) * 1000;

  // Detect-and-skip: if the PR is already MERGED, return immediately. Saves a
  // pointless `gh pr merge` / `glab mr merge` call (which would error
  // "already merged") and a full polling cycle.
  let preState: PrStateInfo;
  try {
    preState = await fetchStateOrThrow(args.number, args.repo);
  } catch (err) {
    return {
      ok: false,
      code: 'fetch_initial_state_failed',
      error: `pr_merge_wait failed to read initial PR state: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  if (preState.state === 'merged') {
    return { ok: true, data: synthesizeAlreadyMerged(args.number, preState) };
  }

  // Delegate the merge itself to the routed prMerge adapter. Pre-Story 1.11
  // this went through a `performMerge` compat shim in handlers/pr_merge.ts;
  // the shim is removed by this story.
  const adapter = getAdapter({ repo: args.repo });
  const mergeResult = await adapter.prMerge({
    number: args.number,
    squash_message: args.squash_message,
    use_merge_queue: args.use_merge_queue,
    skip_train: args.skip_train,
    repo: args.repo,
  });

  if ('platform_unsupported' in mergeResult) {
    return {
      ok: false,
      code: 'pr_merge_platform_unsupported',
      error: `pr_merge platform_unsupported: ${mergeResult.hint}`,
    };
  }
  if (!mergeResult.ok) {
    return { ok: false, code: 'pr_merge_failed', error: mergeResult.error };
  }
  const merge = mergeResult.data;
  if (merge.merged) {
    // Direct path — already on main. No need to poll.
    return { ok: true, data: { ...merge } };
  }

  // Queue path: enrolled but not yet on main. Poll until merged or timeout.
  // Each poll routes through getAdapter().fetchPrState — the hybrid sub-call
  // pattern at work.
  const poll = await pollUntilMerged({
    fetchState: () => fetchStateOrThrow(args.number, args.repo),
    intervalMs: overrides?.intervalMs ?? POLL_INTERVAL_MS,
    timeoutMs,
    now: overrides?.now ?? Date.now,
    sleep: overrides?.sleep ?? defaultSleep,
  });

  if (!poll.ok) {
    if (poll.reason === 'fetch_error') {
      // Critical context: the PR was successfully enrolled — only the polling
      // loop failed. Caller can retry the wait without re-enrolling.
      const lastSnippet = poll.lastState
        ? `last_state: ${poll.lastState.state.toUpperCase()}`
        : 'no successful poll before failure';
      return {
        ok: false,
        code: 'poll_fetch_error',
        error:
          `pr_merge_wait polling failed for PR #${args.number} after enrollment ` +
          `(${lastSnippet}, queue.enforced: ${merge.queue.enforced}): ${poll.error}`,
      };
    }
    return {
      ok: false,
      code: 'poll_timeout',
      error:
        `pr_merge_wait timed out after ${args.timeout_sec ?? DEFAULT_TIMEOUT_SEC}s ` +
        `waiting for PR #${args.number} to land on main ` +
        `(last_state: ${poll.lastState.state.toUpperCase()}, ` +
        `queue.enforced: ${merge.queue.enforced})`,
    };
  }

  return {
    ok: true,
    data: {
      ...merge,
      merged: true,
      pr_state: 'MERGED',
      url: poll.state.url || merge.url,
      merge_commit_sha: poll.state.mergeCommitSha ?? merge.merge_commit_sha,
    },
  };
}

export async function prMergeWaitGithub(
  args: PrMergeWaitArgs,
): Promise<AdapterResult<PrMergeWaitResponse>> {
  return executeMergeWait(args);
}

// Test seam — drives `executeMergeWait` with injected clock + sleep so unit
// tests can run without real wall-clock time. Both adapters share this seam
// (the executor is platform-agnostic).
export async function executeMergeWaitForTest(
  args: PrMergeWaitArgs,
  overrides: ExecuteOverrides,
): Promise<AdapterResult<PrMergeWaitResponse>> {
  return executeMergeWait(args, overrides);
}
