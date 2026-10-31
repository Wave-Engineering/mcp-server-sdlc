/**
 * GitHub `pr_comment` adapter implementation.
 *
 * Lifted from `handlers/pr_comment.ts` per Story 1.8. The handler is now a
 * thin dispatcher; this module owns the GitHub-specific subprocess work and
 * normalizes the response into `AdapterResult<PrCommentResponse>`.
 *
 * Errors that come back from `gh` are converted into `{ok: false, error, code}`
 * — never thrown — so the handler doesn't need a try/catch around the dispatch.
 *
 * Argv shape: `gh pr comment <num> --body <body> [--repo <slug>]`, or
 * `gh issue comment …` for `target: 'issue'` or a number that is not a PR.
 * The comment ID is parsed from the `#issuecomment-<id>` fragment that `gh`
 * prints on stdout (the same for both).
 */

import { execSync } from 'child_process';
import { runArgv } from '../shared/error-norm.js';
import type {
  AdapterResult,
  PrCommentArgs,
  PrCommentResponse,
} from './types.js';

function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

/**
 * Parse a GitHub PR comment ID from the URL `gh pr comment` prints to stdout.
 * Format: https://github.com/<owner>/<repo>/pull/<num>#issuecomment-<id>
 */
function parseGithubCommentId(stdout: string): number | null {
  const match = /#issuecomment-(\d+)/.exec(stdout);
  return match ? parseInt(match[1], 10) : null;
}

// What `gh pr comment` says when the number is an issue, not a PR (#617).
const NOT_A_PR = /Could not resolve to a PullRequest/;

function ghComment(kind: 'pr' | 'issue', args: PrCommentArgs) {
  const cmd = ['gh', kind, 'comment', String(args.number), '--body', args.body];
  if (args.repo !== undefined) {
    cmd.push('--repo', args.repo);
  }
  return runArgv(cmd, projectDir());
}

export async function prCommentGithub(
  args: PrCommentArgs,
): Promise<AdapterResult<PrCommentResponse>> {
  // Bound any exception that escapes the helpers below into a typed result —
  // adapter callers must not have to try/catch.
  try {
    // GitHub issues and PRs share one number space, but `gh pr comment`
    // cannot resolve an issue. `target: 'issue'` goes straight to
    // `gh issue comment`; otherwise a not-a-PR failure retries as an issue,
    // and any other failure is returned as-is.
    let kind: 'pr' | 'issue' = args.target === 'issue' ? 'issue' : 'pr';
    let result = ghComment(kind, args);
    if (kind === 'pr' && result.exitCode !== 0 && NOT_A_PR.test(result.stderr + result.stdout)) {
      kind = 'issue';
      result = ghComment(kind, args);
    }
    if (result.exitCode !== 0) {
      return {
        ok: false,
        code: `gh_${kind}_comment_failed`,
        error: `gh ${kind} comment failed: ${result.stderr.trim() || result.stdout.trim()}`,
      };
    }

    const url = result.stdout.trim().split(/\s+/).pop() ?? result.stdout.trim();
    const commentId = parseGithubCommentId(result.stdout);
    if (commentId === null) {
      return {
        ok: false,
        code: 'gh_comment_id_parse_failed',
        error: `failed to parse comment ID from gh output: ${result.stdout.trim()}`,
      };
    }

    return {
      ok: true,
      data: {
        number: args.number,
        comment_id: commentId,
        url,
      },
    };
  } catch (err) {
    return {
      ok: false,
      code: 'unexpected_error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// `execSync` is intentionally re-imported above so that adapter-level test
// files can `mock.module('child_process', ...)` and intercept this module's
// subprocess calls without needing access to the handler's mock setup.
void execSync;
