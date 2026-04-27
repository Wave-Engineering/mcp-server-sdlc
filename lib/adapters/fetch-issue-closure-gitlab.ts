/**
 * GitLab `fetchIssueClosure` adapter implementation — the GitLab half of the
 * Story 2.20 (#314) hybrid sub-call.
 *
 * Lifted from `handlers/wave_previous_merged.ts`'s `fetchGitlabClosureInfo`.
 * `wave_previous_merged` still treats state-only as closed-by-merged-MR on
 * GitLab: the #183 repro was GitHub-specific (body-keyword closures), and
 * GitLab's default commit-trailer style populates closer info through a
 * different code path. Strengthening this to "closed by merged MR" is a
 * separate feature — keeping the code path untouched avoids a cross-platform
 * regression.
 *
 * Uses the typed `gitlabApiIssue` wrapper from `lib/glab.ts` (the supported
 * path until Phase-3 Story 3.1 deletes `lib/glab.ts`).
 */

import { gitlabApiIssue } from '../glab.js';
import type {
  AdapterResult,
  FetchIssueClosureArgs,
  IssueClosureInfo,
} from './types.js';

function parseSlugOpts(
  slug: string | undefined,
): { owner?: string; repo?: string } | undefined {
  if (slug === undefined) return undefined;
  const idx = slug.indexOf('/');
  if (idx <= 0 || idx === slug.length - 1) return undefined;
  return { owner: slug.slice(0, idx), repo: slug.slice(idx + 1) };
}

export function fetchIssueClosureGitlabSync(
  num: number,
  repo?: string,
): IssueClosureInfo {
  const issue = gitlabApiIssue(num, parseSlugOpts(repo));
  const state = issue.state === 'opened' ? 'OPEN' : 'CLOSED';
  return { state, closedByMergedPR: state === 'CLOSED' };
}

export async function fetchIssueClosureGitlab(
  args: FetchIssueClosureArgs,
): Promise<AdapterResult<IssueClosureInfo>> {
  // Bound any exception (subprocess failure, JSON parse error) into a typed
  // result — adapter callers must not have to try/catch.
  try {
    const data = fetchIssueClosureGitlabSync(args.number, args.repo);
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      code: 'glab_issue_closure_failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
