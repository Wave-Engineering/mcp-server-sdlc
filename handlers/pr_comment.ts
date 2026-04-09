// Origin Operations family handler.
// See docs/handlers/origin-operations-guide.md for the canonical pattern,
// gh ↔ glab field mappings, and normalized response schemas.

import { z } from 'zod';
import type { HandlerDef } from '../types.js';

const inputSchema = z.object({
  number: z.number().int().positive('number must be a positive integer'),
  body: z.string().min(1, 'body must be a non-empty string'),
});

type Input = z.infer<typeof inputSchema>;

function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runCommand(cmd: string[], cwd: string): SpawnResult {
  // Bun.spawnSync with an arg array preserves unicode, code fences, and
  // multi-line markdown verbatim — no shell quoting required.
  // Passing `env: process.env` explicitly ensures we honour any PATH
  // mutations the caller has made since Bun startup.
  const proc = Bun.spawnSync({
    cmd,
    cwd,
    env: process.env as Record<string, string>,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: proc.exitCode ?? -1,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

function detectPlatform(cwd: string): 'github' | 'gitlab' {
  const proc = runCommand(['git', 'remote', 'get-url', 'origin'], cwd);
  if (proc.exitCode !== 0) return 'github';
  const url = proc.stdout.trim();
  return url.includes('gitlab') ? 'gitlab' : 'github';
}

/**
 * Parse a GitHub PR comment ID from the URL `gh pr comment` prints to stdout.
 * Format: https://github.com/<owner>/<repo>/pull/<num>#issuecomment-<id>
 */
function parseGithubCommentId(stdout: string): number | null {
  const match = /#issuecomment-(\d+)/.exec(stdout);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Parse a GitLab MR note ID from the URL `glab mr note` prints to stdout.
 * Format: https://gitlab.com/<group>/<repo>/-/merge_requests/<num>#note_<id>
 */
function parseGitlabNoteId(stdout: string): number | null {
  const match = /#note_(\d+)/.exec(stdout);
  return match ? parseInt(match[1], 10) : null;
}

interface PostResult {
  commentId: number;
  url: string;
}

function postGithubComment(num: number, body: string, cwd: string): PostResult {
  const proc = runCommand(
    ['gh', 'pr', 'comment', String(num), '--body', body],
    cwd,
  );
  if (proc.exitCode !== 0) {
    throw new Error(`gh pr comment failed: ${proc.stderr.trim() || proc.stdout.trim()}`);
  }
  const url = proc.stdout.trim().split(/\s+/).pop() ?? proc.stdout.trim();
  const commentId = parseGithubCommentId(proc.stdout);
  if (commentId === null) {
    throw new Error(`failed to parse comment ID from gh output: ${proc.stdout.trim()}`);
  }
  return { commentId, url };
}

function postGitlabComment(num: number, body: string, cwd: string): PostResult {
  const proc = runCommand(
    ['glab', 'mr', 'note', String(num), '--message', body],
    cwd,
  );
  if (proc.exitCode !== 0) {
    throw new Error(`glab mr note failed: ${proc.stderr.trim() || proc.stdout.trim()}`);
  }
  const url = proc.stdout.trim().split(/\s+/).pop() ?? proc.stdout.trim();
  const commentId = parseGitlabNoteId(proc.stdout);
  if (commentId === null) {
    throw new Error(`failed to parse note ID from glab output: ${proc.stdout.trim()}`);
  }
  return { commentId, url };
}

const prCommentHandler: HandlerDef = {
  name: 'pr_comment',
  description:
    'Post a top-level comment on a PR/MR. Plain markdown body. Returns the created comment/note ID.',
  inputSchema,
  async execute(rawArgs: unknown) {
    let args: Input;
    try {
      args = inputSchema.parse(rawArgs);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error }) }],
      };
    }

    try {
      const cwd = projectDir();
      const platform = detectPlatform(cwd);

      const { commentId, url } =
        platform === 'github'
          ? postGithubComment(args.number, args.body, cwd)
          : postGitlabComment(args.number, args.body, cwd);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              number: args.number,
              comment_id: commentId,
              url,
            }),
          },
        ],
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error }) }],
      };
    }
  },
};

export default prCommentHandler;
