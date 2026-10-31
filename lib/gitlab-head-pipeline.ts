/**
 * Is the MR's `head_pipeline` the pipeline for its CURRENT head? (#588)
 *
 * Right after a push, GitLab can leave `head_pipeline` pointing at the PREVIOUS
 * head's pipeline for a few seconds. Both merge-gate waits read it — `pr_wait_ci`
 * grades its status, and `ci_wait_run(require_merge_result)` anchors on its id —
 * so an unbound `head_pipeline` passes the gate on a commit CI never saw.
 *
 * A pipeline is bound to the head when:
 *  - its `sha` IS the head (branch and detached MR pipelines), or
 *  - it is the MR's merged-results pipeline (`refs/merge-requests/<iid>/merge`)
 *    and its commit has exactly two parents, the second being the head. A
 *    merged-results pipeline runs on an ephemeral merge commit, so a SHA match
 *    is impossible by construction; the second parent is the binding fact
 *    (the same rule as cc-workflow's precheck-ci-source.sh, cc#1357).
 *
 * Anything else is unbound — including a merge-train pipeline, a missing head
 * SHA, and a commit lookup that failed. Unbound never grades.
 *
 * The MR's own head is not proof either: the MR record lags a push until GitLab
 * refreshes it, and in that window it still names the previous head AND that
 * head's pipeline, which then bind to each other. So the head is checked
 * against something outside the MR record first (`HeadFreshness`): the caller's
 * `expected_sha` when it passed one, else the source branch's tip. A head that
 * differs from it, or a tip that cannot be read, is unbound.
 */

import {
  gitlabApiBranch,
  gitlabApiCommit,
  type GitlabMr,
  type GitlabPipeline,
} from './gitlab-api.js';

/** Canonical source-branch head; `diff_refs.head_sha` wins over the top-level `sha`. */
export function mrHeadSha(mr: GitlabMr): string {
  return mr.diff_refs?.head_sha ?? mr.sha ?? '';
}

/** The pipeline GitLab names for the MR — `head_pipeline`, else the `pipeline` alias. */
export function mrPipeline(mr: GitlabMr): GitlabPipeline | null {
  return mr.head_pipeline ?? mr.pipeline ?? null;
}

export type HeadBinding =
  | { bound: true; pipeline: GitlabPipeline; head_sha: string }
  | { bound: false; reason: string };

/** Parent SHAs of a commit, or `undefined` when the lookup failed. */
export type ParentsOf = (sha: string) => string[] | undefined;

/** The source branch's tip commit, or `undefined` when it could not be read. */
export type BranchTipOf = (mr: GitlabMr) => string | undefined;

/** The independent statement of the head the MR record must agree with. */
export type HeadFreshness = { expectedSha: string } | { branchTipOf: BranchTipOf };

function short(sha: string): string {
  return sha.slice(0, 8);
}

/** Why `head` is not yet the head to grade, or `null` when it is. */
function staleHeadReason(mr: GitlabMr, head: string, freshness: HeadFreshness): string | null {
  if ('expectedSha' in freshness) {
    if (head.toLowerCase() === freshness.expectedSha.toLowerCase()) return null;
    return `the MR head is ${short(head)}, not expected_sha ${short(freshness.expectedSha)}: the MR has not caught up with the push yet`;
  }
  const tip = freshness.branchTipOf(mr);
  if (tip === undefined || tip === '') {
    return `could not read the tip of source branch '${mr.source_branch}' to confirm the MR head ${short(head)} is current`;
  }
  if (tip.toLowerCase() === head.toLowerCase()) return null;
  return `the MR head is ${short(head)} but source branch '${mr.source_branch}' is at ${short(tip)}: the MR has not been refreshed to the branch tip yet`;
}

export function bindHeadPipeline(
  mr: GitlabMr,
  parentsOf: ParentsOf,
  freshness: HeadFreshness,
): HeadBinding {
  const p = mrPipeline(mr);
  if (p === null) return { bound: false, reason: 'the MR has no head_pipeline' };

  const head = mrHeadSha(mr);
  if (head === '') {
    return {
      bound: false,
      reason: `the MR reports no head SHA, so pipeline ${p.id} cannot be bound to it`,
    };
  }

  const stale = staleHeadReason(mr, head, freshness);
  if (stale !== null) return { bound: false, reason: stale };

  const psha = p.sha ?? '';
  if (psha !== '' && psha.toLowerCase() === head.toLowerCase()) {
    return { bound: true, pipeline: p, head_sha: head };
  }

  if (psha !== '' && p.ref === `refs/merge-requests/${mr.iid}/merge`) {
    const parents = parentsOf(psha);
    if (parents === undefined) {
      return {
        bound: false,
        reason: `could not read merge commit ${short(psha)} of pipeline ${p.id} to bind it to head ${short(head)}`,
      };
    }
    if (parents.length === 2 && parents[1].toLowerCase() === head.toLowerCase()) {
      return { bound: true, pipeline: p, head_sha: head };
    }
  }

  return {
    bound: false,
    reason:
      `head_pipeline ${p.id} (${p.status}) ran on ${short(psha) || 'an unknown commit'}, not head ` +
      `${short(head)}: the pipeline for the current head is not attached yet`,
  };
}

/**
 * `ParentsOf` backed by the GitLab API, memoised per instance — a commit's
 * parents never change, so one lookup per merge commit per wait is enough.
 */
export function apiParentsOf(opts?: { owner?: string; repo?: string }): ParentsOf {
  const cache = new Map<string, string[]>();
  return (sha) => {
    const hit = cache.get(sha);
    if (hit !== undefined) return hit;
    try {
      const commit = gitlabApiCommit(sha, opts);
      if (!Array.isArray(commit.parent_ids)) return undefined;
      cache.set(sha, commit.parent_ids);
      return commit.parent_ids;
    } catch {
      return undefined;
    }
  };
}

/**
 * `BranchTipOf` backed by the GitLab API. Deliberately NOT memoised: the tip is
 * the thing that moves, and a cached one would bind a stale head again.
 */
export function apiBranchTipOf(opts?: { owner?: string; repo?: string }): BranchTipOf {
  return (mr) => {
    try {
      const id = gitlabApiBranch(mr.source_branch, mr.source_project_id, opts).commit?.id;
      return typeof id === 'string' ? id : undefined;
    } catch {
      return undefined;
    }
  };
}

/** The caller's `expected_sha` when given, else the live branch tip. */
export function headFreshness(
  expectedSha: string | undefined,
  opts?: { owner?: string; repo?: string },
): HeadFreshness {
  return expectedSha !== undefined ? { expectedSha } : { branchTipOf: apiBranchTipOf(opts) };
}
