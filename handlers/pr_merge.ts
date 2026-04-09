// Origin Operations family handler.
// See docs/handlers/origin-operations-guide.md for the canonical pattern,
// gh ↔ glab field mappings, and normalized response schemas.

import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { detectPlatform, gitlabApiMr } from '../lib/glab.js';

// Codebase convention: child_process.execSync (29/36 handlers). Tests mock it
// via `mock.module('child_process', ...)` — see tests/pr_merge.test.ts.
//
// Multi-line squash messages: we write them to a temp file and pass the path
// via --body-file / --squash-message-file (no shell newline escaping needed).
// Short single-line messages go inline via --body / --squash-message with the
// arg value quoted.

const inputSchema = z.object({
  number: z.number().int().positive('number must be a positive integer'),
  squash_message: z.string().optional(),
  use_merge_queue: z.boolean().optional(),
});

type Input = z.infer<typeof inputSchema>;

interface ExecError extends Error {
  stdout?: Buffer | string;
  stderr?: Buffer | string;
  status?: number;
}

interface FailureInfo {
  message: string;
  stderr: string;
}

function bufToString(b: unknown): string {
  if (b === undefined || b === null) return '';
  if (typeof b === 'string') return b;
  if (typeof (b as Buffer).toString === 'function') return (b as Buffer).toString();
  return String(b);
}

/**
 * Extract a failure message + stderr from a thrown exec error. Both real
 * `execSync` errors (Buffer stderr) and test mocks (plain Error) are handled.
 */
function extractFailure(err: unknown): FailureInfo {
  if (err instanceof Error) {
    const e = err as ExecError;
    const stderr = bufToString(e.stderr);
    const stdout = bufToString(e.stdout);
    const message = stderr.trim() || stdout.trim() || err.message;
    // When tests mock by throwing new Error('...merge queue...'), stderr is
    // empty but the merge-queue phrase lives in err.message. Fall back to
    // err.message so the merge-queue detector can see it.
    return { message, stderr: stderr || err.message };
  }
  const text = String(err);
  return { message: text, stderr: text };
}

/**
 * Heuristic for detecting GitHub merge-queue enforcement. Phrasings seen in
 * the wild include:
 *   - "merge strategy for main is set by the merge queue"
 *   - "the merge queue is required"
 *   - "changes must be made through a merge queue"
 * We match case-insensitively on "merge queue" to tolerate phrasing drift.
 */
function stderrIndicatesMergeQueue(text: string): boolean {
  return /merge\s*queue/i.test(text);
}

function exec(cmd: string): string {
  return execSync(cmd, { encoding: 'utf8' });
}

/**
 * Escape a value for safe inclusion inside a single-quoted shell argument.
 * Used only for single-line squash messages; multi-line messages go via file.
 */
function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function writeTempMessageFile(message: string): string {
  // /tmp is cleaned by the OS; we intentionally do not delete the file to avoid
  // complicating the fs-module surface already mocked by tests (writeFileSync only).
  const path = `/tmp/pr-merge-msg-${Date.now()}-${Math.floor(Math.random() * 1e6)}.txt`;
  writeFileSync(path, message);
  return path;
}

function buildGithubMergeCommand(
  number: number,
  auto: boolean,
  squashMessage?: string,
): string {
  const parts = ['gh', 'pr', 'merge', String(number), '--squash', '--delete-branch'];
  if (auto) parts.push('--auto');
  if (squashMessage !== undefined && squashMessage.length > 0) {
    if (squashMessage.includes('\n')) {
      // Multi-line body: write to a temp file and pass via --body-file.
      const tempFile = writeTempMessageFile(squashMessage);
      parts.push('--body-file', shellEscape(tempFile));
    } else {
      parts.push('--body', shellEscape(squashMessage));
    }
  }
  return parts.join(' ');
}

function buildGitlabMergeCommand(number: number, squashMessage?: string): string {
  const parts = [
    'glab',
    'mr',
    'merge',
    String(number),
    '--squash',
    '--remove-source-branch',
    '--yes',
  ];
  if (squashMessage !== undefined && squashMessage.length > 0) {
    // glab exposes --squash-message (inline only). Single-quoted args
    // preserve newlines in POSIX shells.
    parts.push('--squash-message', shellEscape(squashMessage));
  }
  return parts.join(' ');
}

interface GithubPrViewResponse {
  mergeCommit?: { oid?: string } | null;
  url?: string;
}

function fetchGithubPrMergeInfo(number: number): { url: string; merge_commit_sha?: string } {
  const raw = exec(`gh pr view ${number} --json mergeCommit,url`);
  const parsed = JSON.parse(raw) as GithubPrViewResponse;
  return {
    url: parsed.url ?? '',
    merge_commit_sha: parsed.mergeCommit?.oid,
  };
}

function fetchGithubPrUrl(number: number): string {
  const raw = exec(`gh pr view ${number} --json url`);
  const parsed = JSON.parse(raw) as { url?: string };
  return parsed.url ?? '';
}

function fetchGitlabMrMergeInfo(number: number): { url: string; merge_commit_sha?: string } {
  const mr = gitlabApiMr(number);
  return {
    url: mr.web_url ?? '',
    merge_commit_sha: mr.merge_commit_sha ?? undefined,
  };
}

interface MergeSuccess {
  ok: true;
  number: number;
  merged: boolean;
  merge_method: 'direct_squash' | 'merge_queue';
  url: string;
  merge_commit_sha?: string;
  queue_position?: number;
}

interface MergeFailure {
  ok: false;
  error: string;
}

function mergeGithub(args: Input): MergeSuccess | MergeFailure {
  // Forced merge-queue path.
  if (args.use_merge_queue === true) {
    const cmd = buildGithubMergeCommand(args.number, true, args.squash_message);
    try {
      exec(cmd);
    } catch (err) {
      const fail = extractFailure(err);
      return {
        ok: false,
        error: `gh pr merge --auto failed: ${fail.message}`,
      };
    }
    const url = fetchGithubPrUrl(args.number);
    return {
      ok: true,
      number: args.number,
      merged: true,
      merge_method: 'merge_queue',
      url,
    };
  }

  // Default: direct-squash first, fall back to --auto on merge-queue rejection.
  const directCmd = buildGithubMergeCommand(args.number, false, args.squash_message);
  try {
    exec(directCmd);
    const info = fetchGithubPrMergeInfo(args.number);
    return {
      ok: true,
      number: args.number,
      merged: true,
      merge_method: 'direct_squash',
      url: info.url,
      merge_commit_sha: info.merge_commit_sha,
    };
  } catch (err) {
    const fail = extractFailure(err);
    if (!stderrIndicatesMergeQueue(fail.stderr) && !stderrIndicatesMergeQueue(fail.message)) {
      return {
        ok: false,
        error: `gh pr merge failed: ${fail.message}`,
      };
    }
  }

  // Merge-queue fallback.
  const autoCmd = buildGithubMergeCommand(args.number, true, args.squash_message);
  try {
    exec(autoCmd);
  } catch (err) {
    const fail = extractFailure(err);
    return {
      ok: false,
      error: `gh pr merge --auto failed after merge-queue fallback: ${fail.message}`,
    };
  }
  const url = fetchGithubPrUrl(args.number);
  return {
    ok: true,
    number: args.number,
    merged: true,
    merge_method: 'merge_queue',
    url,
  };
}

function mergeGitlab(args: Input): MergeSuccess | MergeFailure {
  // GitLab has no merge-queue concept; always direct.
  const cmd = buildGitlabMergeCommand(args.number, args.squash_message);
  try {
    exec(cmd);
  } catch (err) {
    return {
      ok: false,
      error: `glab mr merge failed: ${extractFailure(err).message}`,
    };
  }
  const info = fetchGitlabMrMergeInfo(args.number);
  return {
    ok: true,
    number: args.number,
    merged: true,
    merge_method: 'direct_squash',
    url: info.url,
    merge_commit_sha: info.merge_commit_sha,
  };
}

const prMergeHandler: HandlerDef = {
  name: 'pr_merge',
  description:
    'Merge a PR/MR with squash + delete source branch. Auto-detects merge-queue enforcement on GitHub and falls back to --auto mode. Supports custom multi-line squash messages.',
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
      const platform = detectPlatform();
      const result = platform === 'github' ? mergeGithub(args) : mergeGitlab(args);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error }) }],
      };
    }
  },
};

export default prMergeHandler;
