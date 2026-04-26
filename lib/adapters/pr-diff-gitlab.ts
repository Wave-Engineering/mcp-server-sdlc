/**
 * GitLab `pr_diff` adapter implementation.
 *
 * Lifted from `handlers/pr_diff.ts` per Story 1.4. Mirrors `pr-diff-github.ts`
 * — the handler dispatches to either depending on cwd platform.
 *
 * GitLab divergences from the GitHub flow:
 * - `glab mr diff <iid>` for the unified diff (no `--json` mode needed).
 * - URL is fetched via `gitlabApiMr` (per Dev Spec §5.3 — the `lib/glab.ts`
 *   wrapper stays). `glab mr view --output json` is unsupported in glab 1.36;
 *   the API path returns the canonical `web_url` directly.
 *
 * Truncation safety-valve mirrors the GitHub adapter; identical thresholds.
 */

import { execSync } from 'child_process';
import { runArgv } from '../shared/error-norm.js';
import { gitlabApiMr } from '../glab.js';
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

function parseSlugOpts(slug: string | undefined): { owner?: string; repo?: string } | undefined {
  if (slug === undefined) return undefined;
  const idx = slug.indexOf('/');
  if (idx <= 0 || idx === slug.length - 1) return undefined;
  return { owner: slug.slice(0, idx), repo: slug.slice(idx + 1) };
}

function countLines(diff: string): number {
  if (diff.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < diff.length; i++) {
    if (diff.charCodeAt(i) === 10) count++;
  }
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

  const lines = diff.split('\n');
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

export async function prDiffGitlab(
  args: PrDiffArgs,
): Promise<AdapterResult<PrDiffResponse>> {
  try {
    const cwd = projectDir();

    // Fetch the unified diff via glab CLI.
    const diffCmd = ['glab', 'mr', 'diff', String(args.number)];
    if (args.repo !== undefined) diffCmd.push('--repo', args.repo);
    const diffResult = runArgv(diffCmd, cwd);
    if (diffResult.exitCode !== 0) {
      return {
        ok: false,
        code: 'glab_mr_diff_failed',
        error: `glab mr diff failed: ${diffResult.stderr.trim() || diffResult.stdout.trim()}`,
      };
    }
    const rawDiff = diffResult.stdout;

    // Fetch the canonical MR URL via the typed `gitlabApiMr` wrapper. Per
    // Dev Spec §5.3, `lib/glab.ts` stays as the shared GitLab REST client;
    // adapters layer on top rather than reimplementing it.
    const mr = gitlabApiMr(args.number, parseSlugOpts(args.repo));
    const url = mr.web_url;

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

// See pr-diff-github.ts for the rationale.
void execSync;
