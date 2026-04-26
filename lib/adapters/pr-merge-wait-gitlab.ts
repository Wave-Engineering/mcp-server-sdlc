/**
 * GitLab `pr_merge_wait` adapter implementation (Story 1.11, #248).
 *
 * Mirrors `pr-merge-wait-github.ts` — both delegate to the shared
 * `executeMergeWait` helper, which is platform-agnostic by virtue of routing
 * every subprocess touch through `getAdapter()`. There is intentionally no
 * GitLab-specific logic here: detect-and-skip uses `fetchPrState`, the merge
 * itself goes through `prMerge`, and the polling loop reuses
 * `lib/pr-merge-wait-poll.ts` (NOT duplicated per platform).
 *
 * The per-platform export pin is what the contract test (`types.test.ts`)
 * needs — every method on `PLATFORM_ADAPTER_METHODS` must exist on both
 * `gitlabAdapter` and `githubAdapter`. The behavior happens to be identical
 * because the orchestration layer is platform-free.
 */

import { executeMergeWait } from './pr-merge-wait-github.js';
import type {
  AdapterResult,
  PrMergeWaitArgs,
  PrMergeWaitResponse,
} from './types.js';

export async function prMergeWaitGitlab(
  args: PrMergeWaitArgs,
): Promise<AdapterResult<PrMergeWaitResponse>> {
  return executeMergeWait(args);
}
