/**
 * Slim cross-platform PR/MR state fetcher — DELEGATING SHIM (Story 1.11, #248).
 *
 * Pre-Story-1.11, this module owned the `gh pr view` and `glab api MR`
 * subprocess calls directly. Story 1.11 lifted those into the platform
 * adapter pair (`lib/adapters/fetch-pr-state-{github,gitlab}.ts`) — the FIRST
 * hybrid sub-call on `PlatformAdapter`. This file now contains ZERO direct
 * subprocess calls and exists only to:
 *
 *   1. Preserve the legacy import surface for `tests/pr_state.test.ts`
 *      (sync `fetchPrState`/`fetchGithubPrState`/`fetchGitlabMrState` API).
 *   2. Re-export `PrState` / `PrStateInfo` for in-tree code that imported
 *      them from this path historically.
 *
 * Closes architect F2 (Phase 1 audit).
 *
 * Why a sync delegation surface (not just `getAdapter().fetchPrState(...)`):
 * - Existing callers in `lib/adapters/pr-merge-{github,gitlab}.ts` and the
 *   `pollUntilMerged` test seam expect a sync call. Wrapping those is a
 *   wider blast radius than this story owns; the spec allows the file to
 *   either delegate OR delete-and-update-importers.
 * - The delegating sync helpers below import the per-platform `*Sync`
 *   variants from the adapters directly, keeping subprocess calls in the
 *   adapter layer (gate-grep happy) without forcing every caller to await.
 *
 * `lib/adapters/pr-merge-{github,gitlab}.ts` are migrated by this story to
 * call `getAdapter().fetchPrState(...)` instead of these helpers — the
 * remaining importers go through the routed adapter (the architecturally
 * correct path). These shims stay as a public surface for `pr_state.test.ts`,
 * which validates the underlying adapter sync helpers.
 */

import { fetchPrStateGithubSync } from './adapters/fetch-pr-state-github.js';
import { fetchPrStateGitlabSync } from './adapters/fetch-pr-state-gitlab.js';
import type { PrState, PrStateInfo } from './adapters/types.js';

export type { PrState, PrStateInfo };

export function fetchGithubPrState(num: number, repo?: string): PrStateInfo {
  return fetchPrStateGithubSync(num, repo);
}

export function fetchGitlabMrState(num: number, repo?: string): PrStateInfo {
  return fetchPrStateGitlabSync(num, repo);
}

export function fetchPrState(
  platform: 'github' | 'gitlab',
  num: number,
  repo?: string,
): PrStateInfo {
  return platform === 'github'
    ? fetchPrStateGithubSync(num, repo)
    : fetchPrStateGitlabSync(num, repo);
}
