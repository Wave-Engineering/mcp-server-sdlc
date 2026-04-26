/**
 * GitLab `pr_create` adapter implementation.
 *
 * Lifted from `handlers/pr_create.ts` per Story 1.3. Mirrors `pr-create-github.ts`
 * — the handler dispatches to either depending on cwd platform.
 *
 * GitLab divergences from the GitHub flow:
 * - `glab mr create --yes` (non-interactive); `gh pr create` doesn't need it.
 * - `glab mr create` doesn't print a parseable URL on stdout — re-fetch via
 *   `glab mr view <head> -F json` to get the canonical IID + web_url.
 * - `glab api projects/<encoded>` for default branch (no `--jq` flag — parse
 *   the JSON in-process).
 */

import { execSync } from 'child_process';
import { runArgv } from '../shared/error-norm.js';
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
 * Resolve the repo's default branch via `glab api projects/<encoded>`.
 * Use `:id` as the project segment when no slug is provided — `glab` resolves
 * that from the cwd remote.
 */
function getDefaultBranch(repo: string | undefined, cwd: string): string {
  const project = repo !== undefined ? repo.replace(/\//g, '%2F') : ':id';
  const result = runArgv(['glab', 'api', `projects/${project}`], cwd);
  if (result.exitCode !== 0 || result.stdout.trim().length === 0) {
    throw new Error(
      `failed to resolve GitLab default branch: ${result.stderr.trim() || 'empty response'}`,
    );
  }
  const parsed = JSON.parse(result.stdout) as { default_branch?: string };
  if (typeof parsed.default_branch !== 'string' || parsed.default_branch.length === 0) {
    throw new Error('default_branch missing or empty in glab api response');
  }
  return parsed.default_branch;
}

function lookupGitlabMr(
  head: string,
  cwd: string,
  repo: string | undefined,
): PrCreateResponse | null {
  const cmd = ['glab', 'mr', 'view', head, '-F', 'json'];
  if (repo !== undefined) cmd.push('-R', repo);
  const view = runArgv(cmd, cwd);
  if (view.exitCode !== 0) return null;
  try {
    const parsed = JSON.parse(view.stdout) as {
      iid: number;
      web_url: string;
      state: string;
      source_branch: string;
      target_branch: string;
    };
    if (parsed.state !== 'opened') return null;
    return {
      number: parsed.iid,
      url: parsed.web_url,
      state: 'open',
      head: parsed.source_branch,
      base: parsed.target_branch,
      created: false,
    };
  } catch {
    return null;
  }
}

export async function prCreateGitlab(
  args: PrCreateArgs,
): Promise<AdapterResult<PrCreateResponse>> {
  try {
    const cwd = projectDir();
    const head = args.head ?? getCurrentBranch(cwd);
    const base = args.base && args.base.length > 0
      ? args.base
      : getDefaultBranch(args.repo, cwd);

    const createCmd = [
      'glab', 'mr', 'create',
      '--title', args.title,
      '--description', args.body,
      '--target-branch', base,
      '--source-branch', head,
      '--yes',
    ];
    if (args.draft) createCmd.push('--draft');
    if (args.repo !== undefined) createCmd.push('-R', args.repo);

    const result = runArgv(createCmd, cwd);
    if (result.exitCode !== 0) {
      const errText = (result.stderr + result.stdout).toLowerCase();
      // glab says "Another open merge request already exists" on duplicate.
      // Treat as the idempotent path: look up + return the existing MR.
      if (errText.includes('already exists')) {
        const existing = lookupGitlabMr(head, cwd, args.repo);
        if (existing) return { ok: true, data: existing };
        return {
          ok: false,
          code: 'mr_exists_lookup_failed',
          error: `glab mr create: MR already exists for branch '${head}' but could not be found via lookup`,
        };
      }
      return {
        ok: false,
        code: 'glab_mr_create_failed',
        error: `glab mr create failed: ${result.stderr.trim() || result.stdout.trim()}`,
      };
    }

    // `glab mr create` doesn't print a URL on stdout. Re-fetch by source-branch.
    const viewCmd = ['glab', 'mr', 'view', head, '-F', 'json'];
    if (args.repo !== undefined) viewCmd.push('-R', args.repo);
    const view = runArgv(viewCmd, cwd);
    if (view.exitCode !== 0) {
      return {
        ok: false,
        code: 'glab_mr_view_failed',
        error: `glab mr view failed: ${view.stderr.trim() || view.stdout.trim()}`,
      };
    }
    const parsed = JSON.parse(view.stdout) as {
      iid: number;
      web_url: string;
      state: string;
      source_branch: string;
      target_branch: string;
    };
    return {
      ok: true,
      data: {
        number: parsed.iid,
        url: parsed.web_url,
        state: 'open',
        head: parsed.source_branch,
        base: parsed.target_branch,
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

// See pr-create-github.ts for the rationale.
void execSync;
