/**
 * GitLab `pr_list` adapter implementation.
 *
 * Lifted from `handlers/pr_list.ts` per Story 1.6. Mirrors `pr-list-github.ts`
 * — the handler dispatches to either depending on cwd platform.
 *
 * GitLab divergences from the GitHub flow:
 * - There is no `glab pr list` equivalent that returns the JSON shape we need;
 *   we delegate to `gitlabApiMrList` (from `lib/glab.ts`) which speaks the
 *   GitLab REST API directly. Per Dev Spec §5.3, `lib/glab.ts` stays as the
 *   shared GitLab REST client during the retrofit.
 * - State translation (`open` → `opened`, etc.) and per_page mapping live
 *   inside `gitlabApiMrList`; this adapter is just a thin call site.
 *
 * `parseSlugOpts` is a tiny single-consumer helper that stays inline (mirrors
 * the same helper in `pr-files-gitlab.ts`).
 */

import { execSync } from 'child_process';
import { gitlabApiMrList } from '../glab.js';
import type {
  AdapterResult,
  NormalizedPr,
  PrListArgs,
  PrListResponse,
} from './types.js';

function parseSlugOpts(slug: string | undefined): { owner?: string; repo?: string } | undefined {
  if (slug === undefined) return undefined;
  const idx = slug.indexOf('/');
  if (idx <= 0 || idx === slug.length - 1) return undefined;
  return { owner: slug.slice(0, idx), repo: slug.slice(idx + 1) };
}

export async function prListGitlab(
  args: PrListArgs,
): Promise<AdapterResult<PrListResponse>> {
  try {
    const parsed = gitlabApiMrList(
      {
        head: args.head,
        base: args.base,
        state: args.state,
        author: args.author,
        limit: args.limit,
      },
      parseSlugOpts(args.repo),
    );
    const prs: NormalizedPr[] = parsed.map((mr) => ({
      number: mr.iid,
      title: mr.title,
      state: mr.state,
      head: mr.source_branch,
      base: mr.target_branch,
      url: mr.web_url,
    }));

    return { ok: true, data: { prs } };
  } catch (err) {
    return {
      ok: false,
      code: 'unexpected_error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// See pr-list-github.ts for the rationale.
void execSync;
