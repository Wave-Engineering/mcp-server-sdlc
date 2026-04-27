/**
 * GitLab `findMergedPrForBranchPrefix` adapter implementation — the GitLab
 * half of the Story 2.21 (#315) hybrid sub-call.
 *
 * Lifted from `handlers/wave_reconcile_mrs.ts`'s local `queryGitlabMergedMrs`
 * helper. Returns the first merged MR whose `source_branch` starts with
 * `prefix`, or `null` when no merged MR matches. Scans the merged MR list
 * client-side — GitLab has no native `source-branch-prefix` filter on the
 * `merge_requests` list endpoint.
 *
 * `limit` controls the size of the merged-list window. The pre-migration
 * handler hardcoded 50 (bug #282). Default is now 100 at the handler layer;
 * the adapter falls back to the same default when `limit` is omitted so
 * direct adapter users see the widened behavior too. GitLab's REST API uses
 * `per_page` — `gitlabApiMrList` forwards the caller's `limit` unchanged.
 *
 * Uses the typed `gitlabApiMrList` wrapper from `lib/gitlab-api.ts`.
 */

import { gitlabApiMrList } from '../gitlab-api.js';
import type {
  AdapterResult,
  FindMergedPrForBranchPrefixArgs,
} from './types.js';

function parseSlugOpts(
  slug: string | undefined,
): { owner?: string; repo?: string } | undefined {
  if (slug === undefined) return undefined;
  const idx = slug.indexOf('/');
  if (idx <= 0 || idx === slug.length - 1) return undefined;
  return { owner: slug.slice(0, idx), repo: slug.slice(idx + 1) };
}

export const DEFAULT_LIMIT = 100;

export function findMergedPrForBranchPrefixGitlabSync(
  prefix: string,
  limit: number,
  repo?: string,
): { url: string } | null {
  if (!Number.isFinite(limit) || limit <= 0 || !Number.isInteger(limit)) {
    throw new Error(
      `findMergedPrForBranchPrefixGitlab: invalid limit ${JSON.stringify(limit)}`,
    );
  }
  const mrs = gitlabApiMrList(
    { state: 'merged', limit },
    parseSlugOpts(repo),
  );
  if (!Array.isArray(mrs) || mrs.length === 0) return null;
  const match = mrs.find(
    (mr) => typeof mr.source_branch === 'string' && mr.source_branch.startsWith(prefix),
  );
  if (!match || typeof match.web_url !== 'string' || match.web_url.length === 0) {
    return null;
  }
  return { url: match.web_url };
}

export async function findMergedPrForBranchPrefixGitlab(
  args: FindMergedPrForBranchPrefixArgs,
): Promise<AdapterResult<{ url: string } | null>> {
  // Bound any exception (subprocess failure, JSON parse error) into a typed
  // result — adapter callers must not have to try/catch.
  try {
    const limit = args.limit ?? DEFAULT_LIMIT;
    const data = findMergedPrForBranchPrefixGitlabSync(args.prefix, limit, args.repo);
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      code: 'glab_api_mr_list_failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
