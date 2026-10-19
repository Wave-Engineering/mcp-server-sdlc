/**
 * GitLab `prReady` adapter (#592): mark a draft MR ready.
 *
 * On GitLab the draft state IS the title prefix, so this PUTs the title with
 * every draft prefix stripped: `glab api -X PUT projects/<id>/merge_requests/<iid>
 * -f title=<title>`. glab's `mr update` porcelain is not used; it rewrites the
 * title on most flags (claudecode-workflow#1235). The MR is read back, and one
 * still in draft is `ok: false`. Policy (the `precheck` pass) is the caller's.
 */

import { execSync } from 'child_process';
import type { AdapterResult, PrReadyArgs, PrReadyResponse } from './types.js';
import { gitlabProject, glabApiJson, viewMrGitlab } from './precheck-shared-gitlab.js';

// GitLab's own draft regex is anchored and case-insensitive:
// `\A(?i)(\[draft\]|\(draft\)|draft:)`. Strip repeatedly, so `Draft: Draft: x`
// becomes `x` (GitLab would still read the remainder as a draft).
const DRAFT_PREFIX = /^\s*(\[draft\]|\(draft\)|draft:)\s*/i;

export function stripDraftPrefix(title: string): string {
  let t = title;
  while (DRAFT_PREFIX.test(t)) t = t.replace(DRAFT_PREFIX, '');
  return t;
}

export async function prReadyGitlab(args: PrReadyArgs): Promise<AdapterResult<PrReadyResponse>> {
  try {
    const before = viewMrGitlab(args.number, args.repo, 'pr_ready_failed');
    if (!before.ok) return before;
    if (!before.data.draft) {
      return { ok: true, data: { number: args.number, draft: false, head_sha: before.data.head_sha, changed: false } };
    }
    const title = stripDraftPrefix(before.data.title);
    if (title.trim() === '') {
      return { ok: false, code: 'pr_ready_failed', error: `MR !${args.number}: the title is only a draft prefix; give it a real title first` };
    }
    const put = glabApiJson(
      ['-X', 'PUT', `projects/${gitlabProject(args.repo)}/merge_requests/${String(args.number)}`, '-f', `title=${title}`],
      'pr_ready_failed',
      `MR !${args.number} (title update)`,
    );
    if (!put.ok) return put;
    const after = viewMrGitlab(args.number, args.repo, 'pr_ready_failed');
    if (!after.ok) return after;
    if (after.data.draft) {
      return { ok: false, code: 'pr_ready_failed', error: `MR !${args.number} is still a draft after the title update` };
    }
    return { ok: true, data: { number: args.number, draft: false, head_sha: after.data.head_sha, changed: true } };
  } catch (err) {
    return { ok: false, code: 'unexpected_error', error: err instanceof Error ? err.message : String(err) };
  }
}

void execSync;
