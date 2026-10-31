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
 */

import { gitlabApiCommit, type GitlabMr, type GitlabPipeline } from './gitlab-api.js';

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

function short(sha: string): string {
  return sha.slice(0, 8);
}

export function bindHeadPipeline(mr: GitlabMr, parentsOf: ParentsOf): HeadBinding {
  const p = mrPipeline(mr);
  if (p === null) return { bound: false, reason: 'the MR has no head_pipeline' };

  const head = mrHeadSha(mr);
  if (head === '') {
    return {
      bound: false,
      reason: `the MR reports no head SHA, so pipeline ${p.id} cannot be bound to it`,
    };
  }

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
