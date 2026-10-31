/**
 * GitHub `issueComments` adapter implementation (#613).
 *
 * Argv:
 *   gh api repos/<owner>/<repo>/issues/<n>/comments --paginate
 *     --jq '.[] | {body, created_at, url: .html_url} | @json'
 *
 * `--paginate` walks every page, so the list is complete. `--jq` turns each
 * page's array into one JSON string per line: without it, `--paginate` prints
 * the pages back to back (`[...][...]`), which is not one JSON document. A
 * string result prints raw, so every line parses on its own.
 *
 * With no `repo`, the path uses gh's `{owner}/{repo}` placeholders, which gh
 * fills in from the current checkout.
 */

import { execSync } from 'child_process';
import { runArgv } from '../shared/error-norm.js';
import type {
  AdapterResult,
  IssueComment,
  IssueCommentsArgs,
  IssueCommentsResponse,
} from './types.js';

const GITHUB_REPO_SLUG = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const JQ = '.[] | {body, created_at, url: .html_url} | @json';

function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

export function issueCommentsGithubArgv(args: IssueCommentsArgs): string[] {
  let slug = '{owner}/{repo}';
  if (args.repo !== undefined) {
    if (!GITHUB_REPO_SLUG.test(args.repo)) {
      throw new Error(`issueCommentsGithub: invalid repo slug ${JSON.stringify(args.repo)}`);
    }
    slug = args.repo;
  }
  return [
    'gh', 'api', `repos/${slug}/issues/${String(args.number)}/comments`,
    '--paginate', '--jq', JQ,
  ];
}

function parseLines(stdout: string): IssueComment[] {
  const comments: IssueComment[] = [];
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    const raw = JSON.parse(line) as { body?: unknown; created_at?: unknown; url?: unknown };
    if (typeof raw.created_at !== 'string') {
      throw new Error(`gh returned a comment with no created_at: ${line.slice(0, 200)}`);
    }
    comments.push({
      body: typeof raw.body === 'string' ? raw.body : '',
      created_at: raw.created_at,
      ...(typeof raw.url === 'string' ? { url: raw.url } : {}),
    });
  }
  return comments;
}

export async function issueCommentsGithub(
  args: IssueCommentsArgs,
): Promise<AdapterResult<IssueCommentsResponse>> {
  try {
    const argv = issueCommentsGithubArgv(args);
    const r = runArgv(argv, projectDir());
    if (r.exitCode !== 0) {
      return {
        ok: false,
        code: 'gh_issue_comments_failed',
        error: `gh api failed (exit ${String(r.exitCode)}): ${r.stderr.trim() || r.stdout.trim()}`,
      };
    }
    // An issue with no comments prints nothing, which is a real empty list:
    // `gh api` exits non-zero on any HTTP error, so empty stdout here is not a
    // swallowed failure.
    return { ok: true, data: { number: args.number, comments: parseLines(r.stdout) } };
  } catch (err) {
    return {
      ok: false,
      code: 'gh_issue_comments_failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// `execSync` is intentionally re-imported above so that adapter-level test
// files can `mock.module('child_process', ...)` and intercept this module's
// subprocess calls.
void execSync;
