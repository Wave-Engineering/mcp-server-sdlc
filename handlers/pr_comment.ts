// Origin Operations family handler.
// See docs/handlers/origin-operations-guide.md for the canonical pattern,
// gh ↔ glab field mappings, and normalized response schemas.

import { execSync } from 'child_process';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';

// Codebase convention: child_process.execSync (29/36 handlers, including
// pr_merge / pr_create). Tests mock it via `mock.module('child_process', ...)`.
// This handler was migrated from Bun's spawn API for uniformity (#253) so the
// adapter retrofit can stub the subprocess boundary in one place.

const inputSchema = z.object({
  number: z.number().int().positive('number must be a positive integer'),
  body: z.string().min(1, 'body must be a non-empty string'),
  repo: z
    .string()
    .regex(/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/, 'repo must be owner/repo format')
    .optional(),
});

type Input = z.infer<typeof inputSchema>;

function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface ExecError extends Error {
  stdout?: Buffer | string;
  stderr?: Buffer | string;
  status?: number;
}

function bufToString(b: unknown): string {
  if (b === undefined || b === null) return '';
  if (typeof b === 'string') return b;
  if (typeof (b as Buffer).toString === 'function') return (b as Buffer).toString();
  return String(b);
}

function shellEscape(value: string): string {
  // Single-quote the arg and escape any embedded single quotes — same form
  // as pr_merge.ts / pr_create.ts. Safe for arbitrary user-supplied strings
  // (markdown bodies, branch names) when the shell is invoked.
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function run(cmd: string[], cwd: string): RunResult {
  const shellCmd = cmd.map(shellEscape).join(' ');
  try {
    const stdout = execSync(shellCmd, { cwd, encoding: 'utf8' });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as ExecError;
    return {
      exitCode: typeof e.status === 'number' ? e.status : -1,
      stdout: bufToString(e.stdout),
      stderr: bufToString(e.stderr) || (err instanceof Error ? err.message : String(err)),
    };
  }
}

function detectPlatform(cwd: string): 'github' | 'gitlab' {
  const proc = run(['git', 'remote', 'get-url', 'origin'], cwd);
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

function postGithubComment(num: number, body: string, cwd: string, repo?: string): PostResult {
  const cmd = ['gh', 'pr', 'comment', String(num), '--body', body];
  if (repo !== undefined) {
    cmd.push('--repo', repo);
  }
  const proc = run(cmd, cwd);
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

function postGitlabComment(num: number, body: string, cwd: string, repo?: string): PostResult {
  const cmd = ['glab', 'mr', 'note', String(num), '--message', body];
  if (repo !== undefined) {
    cmd.push('-R', repo);
  }
  const proc = run(cmd, cwd);
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
          ? postGithubComment(args.number, args.body, cwd, args.repo)
          : postGitlabComment(args.number, args.body, cwd, args.repo);

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
