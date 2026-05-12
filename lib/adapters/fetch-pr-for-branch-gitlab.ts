/**
 * GitLab `fetchPrForBranch` adapter implementation — the GitLab half of the
 * `ibm` keystone hybrid sub-call (Story 2.18, #312).
 *
 * Lifted from `handlers/ibm.ts`'s local `getGitlabMrUrl` helper. Returns
 * `{url, number}` (or `null` when no MR matches the source branch). Uses
 * the typed `gitlabApiMrList` wrapper from `lib/gitlab-api.ts` rather than
 * calling `execSync('glab api ...')` directly — same pattern as
 * `fetch-pr-state-gitlab.ts` and the rest of the GitLab adapter family.
 *
 * State vocabulary is the caller-facing enum
 * (`'open' | 'closed' | 'merged' | 'all'`) — `gitlabApiMrList` internally
 * translates `'open' → 'opened'` and omits the query param entirely for
 * `'all'`. See `lib/gitlab-api.ts` §214 for the mapping table.
 */

import { gitlabApiMrList } from '../gitlab-api.js';
import type {
  AdapterResult,
  FetchPrForBranchArgs,
  PrForBranchRef,
} from './types.js';

function parseSlugOpts(
  slug: string | undefined,
): { owner?: string; repo?: string } | undefined {
  if (slug === undefined) return undefined;
  const idx = slug.indexOf('/');
  if (idx <= 0 || idx === slug.length - 1) return undefined;
  return { owner: slug.slice(0, idx), repo: slug.slice(idx + 1) };
}

type GlabState = 'open' | 'closed' | 'merged' | 'all';

export function fetchPrForBranchGitlabSync(
  branch: string,
  state: GlabState,
  repo?: string,
): PrForBranchRef | null {
  const mrs = gitlabApiMrList(
    { head: branch, state, limit: 1 },
    parseSlugOpts(repo),
  );
  if (!Array.isArray(mrs) || mrs.length === 0) return null;
  const first = mrs[0];
  if (typeof first.iid !== 'number' || typeof first.web_url !== 'string') {
    return null;
  }
  return { number: first.iid, url: first.web_url };
}

export async function fetchPrForBranchGitlab(
  args: FetchPrForBranchArgs,
): Promise<AdapterResult<PrForBranchRef | null>> {
  // Bound any exception (subprocess failure, JSON parse error) into a typed
  // result — adapter callers must not have to try/catch.
  try {
    const state: GlabState = args.state ?? 'open';
    const data = fetchPrForBranchGitlabSync(args.branch, state, args.repo);
    return { ok: true, data };
  } catch (err) {
    // "empty output" from glab for an MR-list query means "no MRs" — treat
    // the same as an empty array rather than propagating as a tool error.
    // Intermittent: glab occasionally returns empty stdout with exit 0 for
    // queries that legitimately have zero results (#428).
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('empty output')) {
      return { ok: true, data: null };
    }
    return {
      ok: false,
      code: 'glab_api_mr_list_failed',
      error: msg,
    };
  }
}
