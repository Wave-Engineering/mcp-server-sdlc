/**
 * GitLab `pr_merge_wait` adapter implementation (Story 1.11, #248).
 *
 * Both adapters delegate to the shared `executeMergeWait` helper
 * (`pr-merge-wait-github.ts`), which is platform-agnostic by virtue of routing
 * every subprocess touch through `getAdapter()`. The one piece of genuinely
 * GitLab-specific behavior lives here: a #524 terminal-state probe supplied to
 * the shared poll loop so an enrolled MR whose pipeline FAILS is reported
 * promptly with its real cause, instead of polled to the full timeout with a
 * generic `poll_timeout`. Before #488 this sub-case failed in seconds via the
 * deterministic `glab_mr_merge_failed` path; #488 traded that for enrollment,
 * and this probe restores the fast, named failure for the pipeline-fails case.
 *
 * Everything else — detect-and-skip via `fetchPrState`, the merge via
 * `prMerge`, the poll loop in `lib/pr-merge-wait-poll.ts` — is shared and not
 * duplicated per platform.
 *
 * The per-platform export pin is what the contract test (`types.test.ts`)
 * needs — every method on `PLATFORM_ADAPTER_METHODS` must exist on both
 * `gitlabAdapter` and `githubAdapter`.
 */

import { executeMergeWait } from './pr-merge-wait-github.js';
import { gitlabApiMr } from '../gitlab-api.js';
import { normalizeGitlabMergeState } from './pr-status-gitlab.js';
import type { TerminalInfo } from '../pr-merge-wait-poll.js';
import type {
  AdapterResult,
  PrMergeWaitArgs,
  PrMergeWaitResponse,
} from './types.js';

function parseSlugOpts(slug: string | undefined): { owner?: string; repo?: string } | undefined {
  if (slug === undefined) return undefined;
  const idx = slug.indexOf('/');
  if (idx <= 0 || idx === slug.length - 1) return undefined;
  return { owner: slug.slice(0, idx), repo: slug.slice(idx + 1) };
}

// #524: pipeline statuses that mean the enrolled auto-merge can no longer land
// by waiting. GitLab tears down merge-when-pipeline-succeeds when the pipeline
// fails/cancels, leaving the MR open forever from the poll's point of view.
// `success`/`skipped` are NOT terminal-failure — a passing pipeline merges the
// MR, which the poll observes directly as `state: merged`.
const TERMINAL_PIPELINE_STATUSES = new Set(['failed', 'canceled', 'cancelled']);

// detailed_merge_status values that mean "still waiting on CI" — NOT terminal.
// Under enrollment `ci_must_pass` means the pipeline has not passed YET (a
// running pipeline), so it must never be read as a permanent block here.
const PENDING_CI_STATUSES = new Set(['ci_must_pass', 'ci_still_running', 'checking']);

/**
 * #524: build the GitLab terminal-state probe for one enrolled MR. Consulted
 * each poll iteration; returns a `TerminalInfo` the moment the MR reaches a
 * state polling cannot resolve — a failed/canceled pipeline, or a fresh
 * non-transient block (approvals dismissed, a conflict appeared) — else `null`
 * (keep waiting).
 *
 * Reads via `gitlabApiMr` directly: `detailed_merge_status` and pipeline status
 * are GitLab-specific fields the cross-platform `PrStateInfo` the poll loop
 * already fetches does not carry. A read failure is swallowed to `null` (keep
 * polling) — the poll's own `fetchState` stays the ground truth for
 * merged/timeout, so an advisory-probe blip must never abort a healthy wait.
 */
export function makeGitlabTerminalCheck(
  args: PrMergeWaitArgs,
): () => Promise<TerminalInfo | null> {
  return async () => {
    let mr;
    try {
      mr = gitlabApiMr(args.number, parseSlugOpts(args.repo));
    } catch {
      return null;
    }

    // A failed/canceled pipeline tears down the enrollment — terminal. Checked
    // first so a `ci_must_pass` MR whose pipeline just failed is reported as
    // the pipeline failure it is, not swallowed by the pending-CI carve-out
    // below.
    const pipelineStatus = (mr.pipeline?.status ?? mr.head_pipeline?.status)?.toLowerCase();
    if (pipelineStatus !== undefined && TERMINAL_PIPELINE_STATUSES.has(pipelineStatus)) {
      return { reason: `enrolled pipeline ${pipelineStatus}` };
    }

    // The MR reclassified to a genuine, non-pipeline-pending block while
    // enrolled — also terminal, since enrollment will not resolve it.
    // `ci_must_pass`/`ci_still_running`/`checking` are excluded: those ARE the
    // thing we are waiting for.
    const dm = mr.detailed_merge_status?.toLowerCase();
    const cls = normalizeGitlabMergeState(mr.detailed_merge_status, mr.merge_status);
    const pendingCi = dm !== undefined && PENDING_CI_STATUSES.has(dm);
    if ((cls === 'blocked' || cls === 'dirty') && !pendingCi) {
      return { reason: `merge blocked: ${mr.detailed_merge_status ?? 'blocked'}` };
    }

    return null;
  };
}

export async function prMergeWaitGitlab(
  args: PrMergeWaitArgs,
): Promise<AdapterResult<PrMergeWaitResponse>> {
  return executeMergeWait(args, { checkTerminal: makeGitlabTerminalCheck(args) });
}
