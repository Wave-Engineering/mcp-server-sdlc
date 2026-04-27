/**
 * GitHub `fetchIssueClosure` adapter implementation — hybrid sub-call landed
 * by Story 2.20 (#314).
 *
 * Lifted verbatim from `handlers/wave_previous_merged.ts`'s
 * `fetchGithubClosureInfo` helper (and its GraphQL query). Returns the narrow
 * `IssueClosureInfo` pair — NOT the full issue body/labels like `fetchIssue`
 * does. Consumed by the `wave_previous_merged` handler to enforce the
 * "closed via merged PR" wave-completion contract (#183 — body-keyword
 * closures like `Closes #N` are missed by the REST events API because
 * `commit_id` is null).
 *
 * The GraphQL query captures both:
 *   1. `closedByPullRequestsReferences` — body-keyword closures
 *   2. `timelineItems[ClosedEvent].closer` — the broader "closed by a PR"
 *      timeline event
 *
 * An issue counts as closed-via-merged-PR iff CLOSED AND at least one linked
 * PR is merged, OR the closer is explicitly a PullRequest.
 */

import { execSync } from 'child_process';
import type {
  AdapterResult,
  FetchIssueClosureArgs,
  IssueClosureInfo,
} from './types.js';

const GH_ISSUE_CLOSURE_QUERY =
  'query($owner:String!,$repo:String!,$num:Int!)' +
  '{repository(owner:$owner,name:$repo){issue(number:$num){' +
  'state ' +
  'closedByPullRequestsReferences(first:5,includeClosedPrs:true){nodes{merged}} ' +
  'timelineItems(first:1,itemTypes:[CLOSED_EVENT]){nodes{... on ClosedEvent{closer{__typename}}}}' +
  '}}}';

interface GhGraphqlResponse {
  data?: {
    repository?: {
      issue?: {
        state?: string;
        closedByPullRequestsReferences?: { nodes?: Array<{ merged?: boolean }> };
        timelineItems?: { nodes?: Array<{ closer?: { __typename?: string } }> };
      };
    };
  };
}

// GitHub's owner/repo grammar: alphanumerics plus `.`, `_`, `-`. Defended at
// the adapter boundary so any caller gets the same protection — a maliciously
// crafted git remote URL can't smuggle shell metacharacters through the
// `execSync` string via `parseRepoSlug()`.
const GITHUB_SLUG_SEGMENT = /^[A-Za-z0-9._-]+$/;
const GITHUB_REPO_SLUG = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function resolveOwnerRepo(repo: string | undefined): { owner: string; repo: string } {
  if (repo !== undefined) {
    if (!GITHUB_REPO_SLUG.test(repo)) {
      throw new Error(`fetchIssueClosureGithub: invalid repo slug ${JSON.stringify(repo)}`);
    }
    const [owner, name] = repo.split('/', 2);
    return { owner, repo: name };
  }
  // Defer to the handler-level slug resolver — the handler parses the current
  // repo slug and passes it in via `args.repo`. We don't call `parseRepoSlug()`
  // from the adapter to avoid coupling the adapter to cwd-based detection;
  // callers pass the slug explicitly.
  throw new Error('fetchIssueClosureGithub: repo slug is required');
}

export function fetchIssueClosureGithubSync(
  num: number,
  repo: string | undefined,
): IssueClosureInfo {
  const { owner, repo: name } = resolveOwnerRepo(repo);
  if (!GITHUB_SLUG_SEGMENT.test(owner) || !GITHUB_SLUG_SEGMENT.test(name)) {
    throw new Error(`fetchIssueClosureGithub: invalid slug characters ${owner}/${name}`);
  }
  const cmd =
    `gh api graphql -f 'query=${GH_ISSUE_CLOSURE_QUERY}' ` +
    `-F owner=${owner} -F repo=${name} -F num=${num}`;
  const raw = execSync(cmd, { encoding: 'utf8' });
  const parsed = JSON.parse(raw) as GhGraphqlResponse;
  const issue = parsed.data?.repository?.issue;
  if (!issue) throw new Error(`github issue ${num} not found`);
  const state = (issue.state ?? '').toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN';
  if (state !== 'CLOSED') return { state: 'OPEN', closedByMergedPR: false };
  const prRefs = issue.closedByPullRequestsReferences?.nodes ?? [];
  const hasMergedPR = prRefs.some((ref) => ref?.merged === true);
  const closerIsPR =
    issue.timelineItems?.nodes?.[0]?.closer?.__typename === 'PullRequest';
  return { state: 'CLOSED', closedByMergedPR: hasMergedPR || closerIsPR };
}

export async function fetchIssueClosureGithub(
  args: FetchIssueClosureArgs,
): Promise<AdapterResult<IssueClosureInfo>> {
  // Bound any exception (subprocess failure, JSON parse error, slug validation)
  // into a typed result — adapter callers must not have to try/catch.
  try {
    const data = fetchIssueClosureGithubSync(args.number, args.repo);
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      code: 'gh_issue_closure_failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// `execSync` is intentionally re-imported above so that adapter-level test
// files can `mock.module('child_process', ...)` and intercept this module's
// subprocess calls.
void execSync;
