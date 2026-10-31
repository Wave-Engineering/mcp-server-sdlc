/**
 * GitLab half of the wave trust gate's freshness anchor (#476).
 *
 * A merged-results pipeline runs against the EPHEMERAL MERGE COMMIT, so its `sha`
 * can never equal the branch HEAD — a SHA match is impossible by construction.
 * GitLab instead publishes `merge_request.head_pipeline`: its own authoritative
 * statement of "the pipeline for this MR's current head". That id IS the anchor.
 *
 * Without it, filtering to `refs/merge-requests/N/merge` runs still lets a GREEN
 * pipeline for a PREVIOUS commit satisfy the gate.
 */

import { gitlabApiMr } from '../gitlab-api.js';
import {
  apiParentsOf,
  bindHeadPipeline,
  headFreshness,
  type HeadFreshness,
  type ParentsOf,
} from '../gitlab-head-pipeline.js';
import type {
  AdapterResult,
  MergeAnchor,
  ResolveMergeAnchorArgs,
} from './types.js';


/**
 * GitLab supports arbitrarily-nested groups (`group/sub/proj`), so a 2-way split
 * on '/' silently resolves the WRONG project (`group/sub`). `repoOptionalSchema`
 * permits that depth by design (#290), and `route.ts` sends 3+-segment slugs to
 * GitLab specifically — so this is reachable, not hypothetical.
 */
function parseSlugOpts(
  slug: string | undefined,
): { owner?: string; repo?: string } | undefined {
  if (!slug) return undefined;
  const idx = slug.lastIndexOf('/');
  if (idx === -1) return undefined;
  return { owner: slug.slice(0, idx), repo: slug.slice(idx + 1) };
}

export async function resolveMergeAnchorGitlab(
  args: ResolveMergeAnchorArgs,
  parentsOf?: ParentsOf,
  freshness?: HeadFreshness,
): Promise<AdapterResult<MergeAnchor>> {
  if (!Number.isInteger(args.number) || args.number <= 0) {
    return {
      ok: false,
      code: 'invalid_number',
      error: `resolveMergeAnchorGitlab: invalid MR iid ${JSON.stringify(args.number)}`,
    };
  }

  try {
    const opts = parseSlugOpts(args.repo);
    const mr = gitlabApiMr(args.number, opts);
    const id = mr.head_pipeline?.id ?? mr.pipeline?.id;

    if (typeof id !== 'number') {
      return {
        ok: false,
        code: 'no_head_pipeline',
        // Fail closed. No head_pipeline means GitLab has not associated a
        // pipeline with this MR's current head — commonly: merged-results
        // pipelines are disabled, or .gitlab-ci.yml admits no merge-request
        // pipelines. Either way we cannot prove freshness, so we must not grade.
        error:
          `MR !${args.number} has no head_pipeline — GitLab has not associated a pipeline with its current head. ` +
          `Cannot anchor a merge-result run to the commit under test. Check that merged-results pipelines are enabled ` +
          `(merge_pipelines_enabled) and that .gitlab-ci.yml admits merge-request pipelines.`,
      };
    }

    // #588: `head_pipeline` is not proof by itself. Right after a push GitLab
    // can still name the PREVIOUS head's pipeline, and anchoring on it lets that
    // head's green merge-result run pass the gate. Refuse unless it is bound to
    // the current head; ci_wait_run holds on this code and re-resolves (#588).
    // The MR record lags a push as well, so its head is checked against
    // expected_sha, else the source branch tip, before anything binds.
    const binding = bindHeadPipeline(
      mr,
      parentsOf ?? apiParentsOf(opts),
      freshness ?? headFreshness(args.expected_sha, opts),
    );
    if (!binding.bound) {
      return {
        ok: false,
        code: 'head_pipeline_not_bound',
        error: `MR !${args.number}: ${binding.reason}. Cannot anchor a merge-result run to the commit under test.`,
      };
    }

    // `head_sha` too, so the pre-grade re-check (anchorsEqual) also sees a head
    // that moved while the pipeline id stayed put.
    return { ok: true, data: { head_pipeline_id: id, head_sha: binding.head_sha } };
  } catch (err) {
    return {
      ok: false,
      code: 'glab_api_mr_failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
