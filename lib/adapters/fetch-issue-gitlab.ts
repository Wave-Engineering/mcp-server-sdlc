/**
 * GitLab `fetchIssue` adapter implementation — the Phase-2 keystone hybrid
 * sub-call (Story 2.1, #295).
 *
 * Uses the typed `gitlabApiIssue` wrapper from `lib/glab.ts` (the supported
 * path until Phase-3 Story 3.1 deletes `lib/glab.ts` as part of the final
 * consumer migration). Normalizes GitLab's `state` vocabulary (`opened` /
 * `closed`) into the adapter-level `IssueState` (`OPEN` / `CLOSED`), and
 * coerces GitLab's nullable `description` to a body string.
 *
 * GitLab returns `iid` (issue-internal ID) for project-scoped issue numbers;
 * we surface it as `number` to match the normalized `AdapterIssue` shape.
 */

import { gitlabApiIssue } from '../glab.js';
import type {
  AdapterIssue,
  AdapterResult,
  FetchIssueArgs,
  IssueState,
} from './types.js';

function parseSlugOpts(
  slug: string | undefined,
): { owner?: string; repo?: string } | undefined {
  if (slug === undefined) return undefined;
  const idx = slug.indexOf('/');
  if (idx <= 0 || idx === slug.length - 1) return undefined;
  return { owner: slug.slice(0, idx), repo: slug.slice(idx + 1) };
}

function normalizeGitlabIssueState(raw: string): IssueState {
  return raw.toLowerCase() === 'closed' ? 'CLOSED' : 'OPEN';
}

export function fetchIssueGitlabSync(num: number, repo?: string): AdapterIssue {
  const issue = gitlabApiIssue(num, parseSlugOpts(repo));
  return {
    number: typeof issue.iid === 'number' ? issue.iid : num,
    title: issue.title ?? '',
    state: normalizeGitlabIssueState(issue.state ?? ''),
    url: issue.web_url ?? '',
    body: issue.description ?? '',
    labels: Array.isArray(issue.labels) ? issue.labels : [],
  };
}

export async function fetchIssueGitlab(
  args: FetchIssueArgs,
): Promise<AdapterResult<AdapterIssue>> {
  // Bound any exception (subprocess failure, JSON parse error) into a typed
  // result — adapter callers must not have to try/catch.
  try {
    const data = fetchIssueGitlabSync(args.number, args.repo);
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      code: 'glab_api_issue_failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
