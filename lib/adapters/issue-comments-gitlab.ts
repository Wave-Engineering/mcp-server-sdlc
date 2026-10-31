/**
 * GitLab `issueComments` adapter implementation (#613).
 *
 * Reads the issue's notes through `gitlabApiIssueNotes` (`lib/gitlab-api.ts`),
 * which pages explicitly and throws rather than truncate. System notes
 * ("changed the description", "added label …") are dropped: they are written by
 * GitLab, not by a person recording an entry-condition state.
 *
 * `trusted` is true when the note's author is a project member (inherited
 * membership included) at Developer access or above, the lowest role that can
 * push. A public project lets any signed-in account comment, so membership is
 * what stops a drive-by `[ec-state EC-1] met` from releasing a gate. The member
 * list is read only when there is a note to judge.
 *
 * GitLab notes have no `web_url`, so `url` is left unset.
 */

import {
  GITLAB_DEVELOPER_ACCESS,
  gitlabApiIssueNotes,
  gitlabApiProjectMembersAll,
  gitlabRepoOpts,
} from '../gitlab-api.js';
import type {
  AdapterResult,
  IssueCommentsArgs,
  IssueCommentsResponse,
} from './types.js';

export async function issueCommentsGitlab(
  args: IssueCommentsArgs,
): Promise<AdapterResult<IssueCommentsResponse>> {
  try {
    const opts = gitlabRepoOpts(args.repo);
    const notes = gitlabApiIssueNotes(args.number, opts).filter((n) => n.system !== true);
    const writers = new Set<number>();
    if (notes.length > 0) {
      for (const m of gitlabApiProjectMembersAll(opts)) {
        if (typeof m.access_level === 'number' && m.access_level >= GITLAB_DEVELOPER_ACCESS) writers.add(m.id);
      }
    }
    const comments = notes.map((n) => {
      const id = n.author?.id;
      const username = n.author?.username;
      return {
        body: n.body ?? '',
        created_at: n.created_at,
        ...(typeof username === 'string' ? { author: username } : {}),
        trusted: typeof id === 'number' && writers.has(id),
      };
    });
    return { ok: true, data: { number: args.number, comments } };
  } catch (err) {
    return {
      ok: false,
      code: 'glab_issue_comments_failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
