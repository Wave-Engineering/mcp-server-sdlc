/**
 * GitLab `fetchPrState` adapter implementation — the GitLab half of the FIRST
 * hybrid sub-call (Story 1.11, #248).
 *
 * Lifted from `lib/pr_state.ts`'s `fetchGitlabMrState`. Returns only what the
 * merge flow needs (state, url, sha). Consumed by:
 *   - `prMergeWait` for "block until merged" polling
 *   - `prMerge` (both platforms) for post-merge URL/sha lookup
 *
 * Uses the typed `gitlabApiMr` wrapper from `lib/glab.ts` rather than calling
 * `execSync('glab api ...')` directly — same pattern as `prMergeGitlab` and
 * the rest of the GitLab adapter family.
 */

import { gitlabApiMr } from '../glab.js';
import type {
  AdapterResult,
  FetchPrStateArgs,
  PrState,
  PrStateInfo,
} from './types.js';

function parseSlugOpts(
  slug: string | undefined,
): { owner?: string; repo?: string } | undefined {
  if (slug === undefined) return undefined;
  const idx = slug.indexOf('/');
  if (idx <= 0 || idx === slug.length - 1) return undefined;
  return { owner: slug.slice(0, idx), repo: slug.slice(idx + 1) };
}

function normalizeGitlabState(raw: string): PrState {
  const lower = raw.toLowerCase();
  if (lower === 'merged') return 'merged';
  if (lower === 'closed') return 'closed';
  return 'open';
}

export function fetchPrStateGitlabSync(num: number, repo?: string): PrStateInfo {
  const mr = gitlabApiMr(num, parseSlugOpts(repo));
  return {
    state: normalizeGitlabState(mr.state ?? ''),
    url: mr.web_url ?? '',
    mergeCommitSha: mr.merge_commit_sha ?? undefined,
  };
}

export async function fetchPrStateGitlab(
  args: FetchPrStateArgs,
): Promise<AdapterResult<PrStateInfo>> {
  // Bound any exception (subprocess failure, JSON parse error) into a typed
  // result — adapter callers must not have to try/catch.
  try {
    const info = fetchPrStateGitlabSync(args.number, args.repo);
    return { ok: true, data: info };
  } catch (err) {
    return {
      ok: false,
      code: 'glab_api_mr_failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
