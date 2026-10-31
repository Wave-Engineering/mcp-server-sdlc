/**
 * GitLab `issueComments` adapter implementation (#613).
 *
 * Reads the issue's notes through `gitlabApiIssueNotes` (`lib/gitlab-api.ts`),
 * which pages explicitly and throws rather than truncate. System notes
 * ("changed the description", "added label …") are dropped: they are written by
 * GitLab, not by a person recording an entry-condition state.
 *
 * GitLab notes have no `web_url`, so `url` is left unset.
 */

import { gitlabApiIssueNotes, gitlabRepoOpts } from '../gitlab-api.js';
import type {
  AdapterResult,
  IssueCommentsArgs,
  IssueCommentsResponse,
} from './types.js';

export async function issueCommentsGitlab(
  args: IssueCommentsArgs,
): Promise<AdapterResult<IssueCommentsResponse>> {
  try {
    const notes = gitlabApiIssueNotes(args.number, gitlabRepoOpts(args.repo));
    const comments = notes
      .filter((n) => n.system !== true)
      .map((n) => ({ body: n.body ?? '', created_at: n.created_at }));
    return { ok: true, data: { number: args.number, comments } };
  } catch (err) {
    return {
      ok: false,
      code: 'glab_issue_comments_failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
