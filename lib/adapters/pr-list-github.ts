/**
 * GitHub `pr_list` adapter implementation.
 *
 * Lifted from `handlers/pr_list.ts` per Story 1.6. The handler is now a
 * thin dispatcher; this module owns the GitHub-specific subprocess work and
 * normalizes the response into `AdapterResult<PrListResponse>`.
 *
 * Errors that come back from `gh` are converted into `{ok: false, error, code}`
 * — never thrown — so the handler doesn't need a try/catch around the dispatch.
 *
 * Replaces the old `quoteArg` string concatenation with `runArgv` (which
 * shell-escapes via `shellEscape` per the established adapter convention).
 */

import { execSync } from 'child_process';
import { runArgv } from '../shared/error-norm.js';
import type {
  AdapterResult,
  NormalizedPr,
  PrListArgs,
  PrListResponse,
} from './types.js';

function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

interface GithubPr {
  number: number;
  title: string;
  state: string;
  headRefName: string;
  baseRefName: string;
  url: string;
}

export async function prListGithub(
  args: PrListArgs,
): Promise<AdapterResult<PrListResponse>> {
  // Bound any exception that escapes the helpers below into a typed result —
  // adapter callers must not have to try/catch.
  try {
    const cwd = projectDir();

    const cmd: string[] = ['gh', 'pr', 'list'];
    if (args.head !== undefined) cmd.push('--head', args.head);
    if (args.base !== undefined) cmd.push('--base', args.base);
    cmd.push('--state', args.state);
    if (args.author !== undefined) cmd.push('--author', args.author);
    cmd.push('--limit', String(args.limit));
    cmd.push('--json', 'number,title,state,headRefName,baseRefName,url');
    if (args.repo !== undefined) cmd.push('--repo', args.repo);

    const result = runArgv(cmd, cwd);
    if (result.exitCode !== 0) {
      return {
        ok: false,
        code: 'gh_pr_list_failed',
        error: `gh pr list failed: ${result.stderr.trim() || result.stdout.trim()}`,
      };
    }

    const parsed = JSON.parse(result.stdout) as GithubPr[];
    const prs: NormalizedPr[] = parsed.map((pr) => ({
      number: pr.number,
      title: pr.title,
      state: pr.state,
      head: pr.headRefName,
      base: pr.baseRefName,
      url: pr.url,
    }));

    return { ok: true, data: { prs } };
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
