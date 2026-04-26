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
 * Argv shape: `gh pr comment <num> --body <body> [--repo <slug>]`. The
 * comment ID is parsed from the `#issuecomment-<id>` fragment that `gh`
 * prints on stdout.
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

export async function prCommentGithub(
  args: PrCommentArgs,
): Promise<AdapterResult<PrCommentResponse>> {
  // Bound any exception that escapes the helpers below into a typed result —
  // adapter callers must not have to try/catch.
  try {
    const cwd = projectDir();
    const cmd = ['gh', 'pr', 'comment', String(args.number), '--body', args.body];
    if (args.repo !== undefined) {
      cmd.push('--repo', args.repo);
    }

    const result = runArgv(cmd, cwd);
    if (result.exitCode !== 0) {
      return {
        ok: false,
        code: 'gh_pr_comment_failed',
        error: `gh pr comment failed: ${result.stderr.trim() || result.stdout.trim()}`,
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
