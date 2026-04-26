/**
 * GitHub `pr_create` adapter implementation.
 *
 * Lifted from `handlers/pr_create.ts` per Story 1.3. The handler is now a
 * thin dispatcher; this module owns the GitHub-specific subprocess work and
 * normalizes the response into `AdapterResult<PrCreateResponse>`.
 *
 * Errors that come back from `gh` are converted into `{ok: false, error, code}`
 * — never thrown — so the handler doesn't need a try/catch around the dispatch.
 */

import { execSync } from 'child_process';
import { runArgv, type RunResult } from '../shared/error-norm.js';
import type {
  AdapterResult,
  PrCreateArgs,
  PrCreateResponse,
} from './types.js';

function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

function getCurrentBranch(cwd: string): string {
  const result = runArgv(['git', 'branch', '--show-current'], cwd);
  if (result.exitCode !== 0) {
    throw new Error(`git branch --show-current failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

/**
 * Resolve the repo's default branch via `gh repo view`.
 * GitHub-specific path; mirror in `pr-create-gitlab.ts` uses `glab api projects/<encoded>`.
 */
function getDefaultBranch(repo: string | undefined, cwd: string): string {
  const cmd = ['gh', 'repo', 'view'];
  if (repo !== undefined) cmd.push(repo);
  cmd.push('--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name');
  const result = runArgv(cmd, cwd);
  if (result.exitCode !== 0 || result.stdout.trim().length === 0) {
    throw new Error(
      `failed to resolve GitHub default branch: ${result.stderr.trim() || 'empty response'}`,
    );
  }
  return result.stdout.trim();
}

function lookupGithubPr(
  head: string,
  cwd: string,
  repo: string | undefined,
): PrCreateResponse | null {
  const cmd = [
    'gh', 'pr', 'list',
    '--head', head,
    '--state', 'open',
    '--json', 'number,url,state,headRefName,baseRefName',
    '--limit', '1',
  ];
  if (repo !== undefined) cmd.push('--repo', repo);
  const list = runArgv(cmd, cwd);
  if (list.exitCode !== 0) return null;
  const prs = JSON.parse(list.stdout) as Array<{
    number: number;
    url: string;
    state: string;
    headRefName: string;
    baseRefName: string;
  }>;
  if (prs.length === 0) return null;
  return {
    number: prs[0].number,
    url: prs[0].url,
    state: 'open',
    head: prs[0].headRefName,
    base: prs[0].baseRefName,
    created: false,
  };
}

function viewGithubPr(
  prNumber: number,
  cwd: string,
  repo: string | undefined,
): RunResult {
  const cmd = [
    'gh', 'pr', 'view', String(prNumber),
    '--json', 'number,url,state,headRefName,baseRefName',
  ];
  if (repo !== undefined) cmd.push('--repo', repo);
  return runArgv(cmd, cwd);
}

export async function prCreateGithub(
  args: PrCreateArgs,
): Promise<AdapterResult<PrCreateResponse>> {
  // Bound any exception that escapes the helpers below into a typed result —
  // adapter callers must not have to try/catch.
  try {
    const cwd = projectDir();
    const head = args.head ?? getCurrentBranch(cwd);
    const base = args.base && args.base.length > 0
      ? args.base
      : getDefaultBranch(args.repo, cwd);

    const createCmd = [
      'gh', 'pr', 'create',
      '--title', args.title,
      '--body', args.body,
      '--base', base,
      '--head', head,
    ];
    if (args.draft) createCmd.push('--draft');
    if (args.repo !== undefined) createCmd.push('--repo', args.repo);

    const result = runArgv(createCmd, cwd);
    if (result.exitCode !== 0) {
      const errText = (result.stderr + result.stdout).toLowerCase();
      // gh says "a pull request for branch ... already exists" on duplicate.
      // Treat as the idempotent path: look up + return the existing PR.
      if (errText.includes('already exists')) {
        const existing = lookupGithubPr(head, cwd, args.repo);
        if (existing) return { ok: true, data: existing };
        return {
          ok: false,
          code: 'pr_exists_lookup_failed',
          error: `gh pr create: PR already exists for branch '${head}' but could not be found via lookup`,
        };
      }
      return {
        ok: false,
        code: 'gh_pr_create_failed',
        error: `gh pr create failed: ${result.stderr.trim() || result.stdout.trim()}`,
      };
    }

    // gh prints the PR URL on stdout. Parse the number from the URL.
    const url = result.stdout.trim().split('\n').pop() ?? '';
    const numMatch = /\/pull\/(\d+)/.exec(url);
    if (!numMatch) {
      return {
        ok: false,
        code: 'gh_url_parse_failed',
        error: `gh pr create: could not parse PR number from output: ${url}`,
      };
    }
    const prNumber = parseInt(numMatch[1], 10);

    // Fetch canonical details so the response shape matches the lookup path.
    const view = viewGithubPr(prNumber, cwd, args.repo);
    if (view.exitCode !== 0) {
      return {
        ok: false,
        code: 'gh_pr_view_failed',
        error: `gh pr view failed: ${view.stderr.trim() || view.stdout.trim()}`,
      };
    }
    const parsed = JSON.parse(view.stdout) as {
      number: number;
      url: string;
      state: string;
      headRefName: string;
      baseRefName: string;
    };
    return {
      ok: true,
      data: {
        number: parsed.number,
        url: parsed.url,
        state: 'open',
        head: parsed.headRefName,
        base: parsed.baseRefName,
        created: true,
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
