/**
 * GitLab `findExistingPr` adapter implementation — the GitLab half of the
 * `wave_finalize` idempotency hybrid sub-call (Story 2.23, #317).
 *
 * Lifted from `handlers/wave_finalize.ts`'s local `findExistingGitlabMr`
 * helper. Returns the first MR matching `(head, base, state)` normalized to
 * the adapter's `NormalizedPr` shape, or `null` when no match exists. Uses
 * the typed `gitlabApiMrList` wrapper from `lib/gitlab-api.ts` — same pattern as
 * the sibling `fetch-pr-for-branch-gitlab.ts`.
 *
 * State vocabulary is the caller-facing enum (`'open' | 'closed' | 'merged'`)
 * — `gitlabApiMrList` internally translates `'open' → 'opened'`. The
 * returned `NormalizedPr.state` is the raw platform string (`'opened' |
 * 'closed' | 'merged' | 'locked'`) so consumers that care about the
 * fine-grained GitLab vocabulary still see it. Callers that want the
 * normalized `'open' | ...` form should post-process.
 */

import { gitlabApiMrList } from '../gitlab-api.js';
import type {
  AdapterResult,
  FindExistingPrArgs,
  NormalizedPr,
} from './types.js';

function parseSlugOpts(
  slug: string | undefined,
): { owner?: string; repo?: string } | undefined {
  if (slug === undefined) return undefined;
  const idx = slug.indexOf('/');
  if (idx <= 0 || idx === slug.length - 1) return undefined;
  return { owner: slug.slice(0, idx), repo: slug.slice(idx + 1) };
}

type GlabState = 'open' | 'closed' | 'merged';

export function findExistingPrGitlabSync(
  head: string,
  base: string,
  state: GlabState,
  repo?: string,
  cwd?: string,
): NormalizedPr | null {
  // `cwd` defaults to undefined → pre-#453 behavior (resolves slug + runs glab
  // from process.cwd()). Threading an explicit cwd roots both the
  // `git remote get-url origin` slug resolution and the `glab api` call in that
  // directory — required when wave_finalize runs against a worktree.
  const mrs = gitlabApiMrList(
    { head, base, state, limit: 1 },
    parseSlugOpts(repo),
    cwd,
  );
  if (!Array.isArray(mrs) || mrs.length === 0) return null;
  const first = mrs[0];
  if (
    typeof first.iid !== 'number' ||
    typeof first.web_url !== 'string' ||
    first.web_url.length === 0 ||
    typeof first.source_branch !== 'string' ||
    typeof first.target_branch !== 'string'
  ) {
    return null;
  }
  return {
    number: first.iid,
    title: typeof first.title === 'string' ? first.title : '',
    state: typeof first.state === 'string' ? first.state : state,
    head: first.source_branch,
    base: first.target_branch,
    url: first.web_url,
  };
}

export async function findExistingPrGitlab(
  args: FindExistingPrArgs,
): Promise<AdapterResult<NormalizedPr | null>> {
  // Bound any exception (subprocess failure, JSON parse error) into a typed
  // result — adapter callers must not have to try/catch.
  try {
    const data = findExistingPrGitlabSync(
      args.head,
      args.base,
      args.state,
      args.repo,
      args.cwd,
    );
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      code: 'glab_api_mr_list_failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
