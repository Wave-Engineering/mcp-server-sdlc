/**
 * GitLab `pr_status` adapter implementation.
 *
 * Lifted from `handlers/pr_status.ts` per Story 1.7. Mirrors `pr-status-github.ts`
 * — the handler dispatches to either depending on cwd platform.
 *
 * GitLab divergences from the GitHub flow:
 * - There is no `glab pr status` equivalent that returns the full state +
 *   detailed_merge_status + pipeline shape we need; we delegate to
 *   `gitlabApiMr` (from `lib/glab.ts`) which speaks the GitLab REST API
 *   directly. Per Dev Spec §5.3, `lib/glab.ts` stays as the shared GitLab
 *   REST client during the retrofit.
 *
 * **Story 1.7 (#244) — explicit pipeline-status fallthrough.**
 *
 * The pre-migration handler did:
 *   const pipelineStatus = mr.pipeline?.status ?? mr.head_pipeline?.status;
 *   const checks = aggregateGitlabPipeline(pipelineStatus);
 * which silently produced `summary: 'none'` whenever both `pipeline?.status`
 * and `head_pipeline?.status` were undefined — making a misconfigured-CI MR
 * indistinguishable from an MR with no pipeline data at all.
 *
 * **Resolution:** when both fields are absent, the adapter now returns
 * `summary: 'no_pipeline_data'` (a typed `PrStatusChecksSummary` literal,
 * defined in `types.ts`). Callers can branch on this discriminator instead
 * of guessing at the cause of an empty checks aggregate. The
 * `aggregateGitlabPipeline` helper retains the legacy behavior for the
 * "pipeline status string is empty/falsy" case (returns `summary: 'none'`),
 * so an MR that explicitly reports an empty status is still distinguishable
 * from one with no pipeline structure at all.
 */

import { execSync } from 'child_process';
import { gitlabApiMr } from '../glab.js';
import type {
  AdapterResult,
  PrStatusArgs,
  PrStatusChecksAggregate,
  PrStatusMergeState,
  PrStatusResponse,
  PrStatusState,
} from './types.js';

function parseSlugOpts(slug: string | undefined): { owner?: string; repo?: string } | undefined {
  if (slug === undefined) return undefined;
  const idx = slug.indexOf('/');
  if (idx <= 0 || idx === slug.length - 1) return undefined;
  return { owner: slug.slice(0, idx), repo: slug.slice(idx + 1) };
}

// --- GitLab normalization (preserved verbatim from handlers/pr_status.ts) ---

function normalizeGitlabState(state: string): PrStatusState {
  const s = (state || '').toLowerCase();
  if (s === 'merged') return 'merged';
  if (s === 'closed') return 'closed';
  return 'open';
}

function normalizeGitlabMergeState(
  detailedMergeStatus: string | undefined,
  mergeStatus: string | undefined,
): PrStatusMergeState {
  const dm = (detailedMergeStatus || '').toLowerCase();
  if (dm === 'mergeable') return 'clean';
  if (dm === 'ci_still_running' || dm === 'checking') return 'unknown';
  if (
    dm === 'broken_status' ||
    dm === 'conflict' ||
    dm === 'ci_must_pass' ||
    dm === 'discussions_not_resolved' ||
    dm === 'draft_status' ||
    dm === 'not_approved' ||
    dm === 'blocked_status'
  ) {
    // conflicts are "dirty", other blockers are "blocked"
    if (dm === 'conflict' || dm === 'broken_status') return 'dirty';
    return 'blocked';
  }
  // Fall back to legacy `merge_status`: can_be_merged / cannot_be_merged / unchecked
  const ms = (mergeStatus || '').toLowerCase();
  if (ms === 'can_be_merged') return 'clean';
  if (ms === 'cannot_be_merged') return 'dirty';
  return 'unknown';
}

export function aggregateGitlabPipeline(
  pipelineStatus: string | undefined,
): PrStatusChecksAggregate {
  if (!pipelineStatus) {
    return { total: 0, passed: 0, failed: 0, pending: 0, summary: 'none' };
  }
  const s = pipelineStatus.toLowerCase();
  if (s === 'success') {
    return { total: 1, passed: 1, failed: 0, pending: 0, summary: 'all_passed' };
  }
  if (s === 'failed' || s === 'canceled' || s === 'cancelled') {
    return { total: 1, passed: 0, failed: 1, pending: 0, summary: 'has_failures' };
  }
  // running, pending, created, scheduled, preparing, waiting_for_resource, manual
  return { total: 1, passed: 0, failed: 0, pending: 1, summary: 'pending' };
}

export async function prStatusGitlab(
  args: PrStatusArgs,
): Promise<AdapterResult<PrStatusResponse>> {
  try {
    const mr = gitlabApiMr(args.number, parseSlugOpts(args.repo));

    const state = normalizeGitlabState(mr.state);
    const merge_state = normalizeGitlabMergeState(mr.detailed_merge_status, mr.merge_status);
    const mergeable = merge_state === 'clean';

    // Story 1.7 explicit-fallthrough fix: when BOTH pipeline?.status and
    // head_pipeline?.status are undefined, the MR has no pipeline data at
    // all — report it explicitly so callers can distinguish "no CI configured"
    // from "checks haven't been reported yet".
    const primaryStatus = mr.pipeline?.status;
    const fallbackStatus = mr.head_pipeline?.status;
    let checks: PrStatusChecksAggregate;
    if (primaryStatus === undefined && fallbackStatus === undefined) {
      checks = {
        total: 0,
        passed: 0,
        failed: 0,
        pending: 0,
        summary: 'no_pipeline_data',
      };
    } else {
      checks = aggregateGitlabPipeline(primaryStatus ?? fallbackStatus);
    }

    return {
      ok: true,
      data: {
        number: args.number,
        state,
        merge_state,
        mergeable,
        checks,
        url: mr.web_url,
      },
    };
  } catch (err) {
    return {
      ok: false,
      code: 'unexpected_error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// See pr-status-github.ts for the rationale.
void execSync;
