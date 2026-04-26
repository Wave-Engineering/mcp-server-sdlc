/**
 * GitHub `pr_diff` adapter implementation.
 *
 * Lifted from `handlers/pr_diff.ts` per Story 1.4. The handler is now a
 * thin dispatcher; this module owns the GitHub-specific subprocess work and
 * normalizes the response into `AdapterResult<PrDiffResponse>`.
 *
 * Errors that come back from `gh` are converted into `{ok: false, error, code}`
 * — never thrown — so the handler doesn't need a try/catch around the dispatch.
 *
 * Truncation safety-valve (`MAX_LINES`/`HEAD_KEEP`/`TAIL_KEEP`) is preserved
 * in-adapter; it's a single-consumer concern that does not warrant a shared
 * helper today.
 */

import { execSync } from 'child_process';
import { runArgv } from '../shared/error-norm.js';
import type {
  AdapterResult,
  PrDiffArgs,
  PrDiffResponse,
} from './types.js';

const MAX_LINES = 10000;
const HEAD_KEEP = 5000;
const TAIL_KEEP = 5000;

function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

function countLines(diff: string): number {
  if (diff.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < diff.length; i++) {
    if (diff.charCodeAt(i) === 10) count++;
  }
  // If the diff doesn't end with a newline, the last line still counts.
  if (diff.charCodeAt(diff.length - 1) !== 10) count++;
  return count;
}

function countFiles(diff: string): number {
  if (diff.length === 0) return 0;
  const matches = diff.match(/^diff --git /gm);
  return matches ? matches.length : 0;
}

interface TruncateResult {
  diff: string;
  truncated: boolean;
}

function maybeTruncate(diff: string, lineCount: number): TruncateResult {
  if (lineCount <= MAX_LINES) {
    return { diff, truncated: false };
  }

  // Split on newlines while preserving them.
  const lines = diff.split('\n');
  // If diff ends with '\n', split produces a trailing empty string; drop it
  // so the keep-count math lines up with countLines() above.
  const hadTrailingNewline = lines.length > 0 && lines[lines.length - 1] === '';
  if (hadTrailingNewline) lines.pop();

  const totalLines = lines.length;
  const head = lines.slice(0, HEAD_KEEP);
  const tail = lines.slice(totalLines - TAIL_KEEP);
  const omitted = totalLines - HEAD_KEEP - TAIL_KEEP;

  const joined =
    head.join('\n') +
    `\n... [${omitted} lines omitted] ...\n` +
    tail.join('\n') +
    (hadTrailingNewline ? '\n' : '');

  return { diff: joined, truncated: true };
}

export async function prDiffGithub(
  args: PrDiffArgs,
): Promise<AdapterResult<PrDiffResponse>> {
  // Bound any exception that escapes the helpers below into a typed result —
  // adapter callers must not have to try/catch.
  try {
    const cwd = projectDir();

    // Fetch the unified diff.
    const diffCmd = ['gh', 'pr', 'diff', String(args.number)];
    if (args.repo !== undefined) diffCmd.push('--repo', args.repo);
    const diffResult = runArgv(diffCmd, cwd);
    if (diffResult.exitCode !== 0) {
      return {
        ok: false,
        code: 'gh_pr_diff_failed',
        error: `gh pr diff failed: ${diffResult.stderr.trim() || diffResult.stdout.trim()}`,
      };
    }
    const rawDiff = diffResult.stdout;

    // Fetch the canonical PR URL.
    const viewCmd = ['gh', 'pr', 'view', String(args.number), '--json', 'url'];
    if (args.repo !== undefined) viewCmd.push('--repo', args.repo);
    const viewResult = runArgv(viewCmd, cwd);
    if (viewResult.exitCode !== 0) {
      return {
        ok: false,
        code: 'gh_pr_view_failed',
        error: `gh pr view failed: ${viewResult.stderr.trim() || viewResult.stdout.trim()}`,
      };
    }
    const parsed = JSON.parse(viewResult.stdout) as { url: string };
    const url = parsed.url;

    const rawLineCount = countLines(rawDiff);
    const fileCount = countFiles(rawDiff);
    const { diff, truncated } = maybeTruncate(rawDiff, rawLineCount);
    const lineCount = truncated ? countLines(diff) : rawLineCount;

    return {
      ok: true,
      data: {
        number: args.number,
        diff,
        line_count: lineCount,
        file_count: fileCount,
        url,
        truncated,
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
