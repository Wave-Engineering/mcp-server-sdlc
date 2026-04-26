/**
 * GitLab `pr_comment` adapter implementation.
 *
 * Lifted from `handlers/pr_comment.ts` per Story 1.8. Mirrors
 * `pr-comment-github.ts` — the handler dispatches to either depending on cwd
 * platform.
 *
 * GitLab divergences from the GitHub flow:
 * - `glab mr note` (not `pr comment`).
 * - `--message` flag (not `--body`).
 * - `-R` repo flag (not `--repo`).
 * - Note ID parsed from `#note_<id>` fragment (not `#issuecomment-<id>`).
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
 * Parse a GitLab MR note ID from the URL `glab mr note` prints to stdout.
 * Format: https://gitlab.com/<group>/<repo>/-/merge_requests/<num>#note_<id>
 */
function parseGitlabNoteId(stdout: string): number | null {
  const match = /#note_(\d+)/.exec(stdout);
  return match ? parseInt(match[1], 10) : null;
}

export async function prCommentGitlab(
  args: PrCommentArgs,
): Promise<AdapterResult<PrCommentResponse>> {
  try {
    const cwd = projectDir();
    const cmd = ['glab', 'mr', 'note', String(args.number), '--message', args.body];
    if (args.repo !== undefined) {
      cmd.push('-R', args.repo);
    }

    const result = runArgv(cmd, cwd);
    if (result.exitCode !== 0) {
      return {
        ok: false,
        code: 'glab_mr_note_failed',
        error: `glab mr note failed: ${result.stderr.trim() || result.stdout.trim()}`,
      };
    }

    const url = result.stdout.trim().split(/\s+/).pop() ?? result.stdout.trim();
    const noteId = parseGitlabNoteId(result.stdout);
    if (noteId === null) {
      return {
        ok: false,
        code: 'glab_note_id_parse_failed',
        error: `failed to parse note ID from glab output: ${result.stdout.trim()}`,
      };
    }

    return {
      ok: true,
      data: {
        number: args.number,
        comment_id: noteId,
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

// See pr-comment-github.ts for the rationale.
void execSync;
