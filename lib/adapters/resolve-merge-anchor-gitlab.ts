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
): Promise<AdapterResult<MergeAnchor>> {
  if (!Number.isInteger(args.number) || args.number <= 0) {
    return {
      ok: false,
      code: 'invalid_number',
      error: `resolveMergeAnchorGitlab: invalid MR iid ${JSON.stringify(args.number)}`,
    };
  }

  try {
    const mr = gitlabApiMr(args.number, parseSlugOpts(args.repo));
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

    return { ok: true, data: { head_pipeline_id: id } };
  } catch (err) {
    return {
      ok: false,
      code: 'glab_api_mr_failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
