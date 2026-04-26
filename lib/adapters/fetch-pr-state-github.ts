/**
 * GitHub `fetchPrState` adapter implementation — the FIRST hybrid sub-call
 * lifted into the platform-adapter pair (Story 1.11, #248).
 *
 * Lifted from `lib/pr_state.ts`'s `fetchGithubPrState`. Returns only what the
 * merge flow needs (state, url, sha) — intentionally narrower than `prStatus`,
 * which fetches checks + mergeability separately. Consumed by:
 *   - `prMergeWait` for "block until merged" polling
 *   - `prMerge` (both platforms) for post-merge URL/sha lookup + the #258 fix
 *     (read actual state after gh exit-0 instead of trusting that gh==merged)
 *
 * Per Dev Spec §5.5, hybrid sub-calls live on `PlatformAdapter` and are
 * routed through `getAdapter()` like any other method — there is no separate
 * "hybrid" registry. The adapter contract test in `types.test.ts` enforces
 * presence on both platforms.
 */

import { execSync } from 'child_process';
import type {
  AdapterResult,
  FetchPrStateArgs,
  PrState,
  PrStateInfo,
} from './types.js';

interface GithubPrViewResponse {
  state?: string;
  url?: string;
  mergeCommit?: { oid?: string } | null;
}

// Same charset as merge_queue_detect.ts and wave_previous_merged.ts — GitHub's
// owner/repo grammar. Defended at the adapter boundary so any caller (handler,
// peer adapter) gets the same protection without having to remember to
// validate themselves.
const GITHUB_REPO_SLUG = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function repoFlag(repo: string | undefined): string {
  if (repo === undefined) return '';
  if (!GITHUB_REPO_SLUG.test(repo)) {
    throw new Error(`fetchPrStateGithub: invalid repo slug ${JSON.stringify(repo)}`);
  }
  return ` --repo ${repo}`;
}

function normalizeGithubState(raw: string): PrState {
  const upper = raw.toUpperCase();
  if (upper === 'MERGED') return 'merged';
  if (upper === 'CLOSED') return 'closed';
  return 'open';
}

export function fetchPrStateGithubSync(num: number, repo?: string): PrStateInfo {
  const raw = execSync(
    `gh pr view ${num} --json state,url,mergeCommit${repoFlag(repo)}`,
    { encoding: 'utf8' },
  );
  const parsed = JSON.parse(raw) as GithubPrViewResponse;
  return {
    state: normalizeGithubState(parsed.state ?? ''),
    url: parsed.url ?? '',
    mergeCommitSha: parsed.mergeCommit?.oid,
  };
}

export async function fetchPrStateGithub(
  args: FetchPrStateArgs,
): Promise<AdapterResult<PrStateInfo>> {
  // Bound any exception (subprocess failure, JSON parse error, slug validation)
  // into a typed result — adapter callers must not have to try/catch.
  try {
    const info = fetchPrStateGithubSync(args.number, args.repo);
    return { ok: true, data: info };
  } catch (err) {
    return {
      ok: false,
      code: 'gh_pr_view_failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// `execSync` is intentionally re-imported above so that adapter-level test
// files can `mock.module('child_process', ...)` and intercept this module's
// subprocess calls.
void execSync;
