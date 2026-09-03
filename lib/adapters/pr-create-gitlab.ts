/**
 * GitLab `pr_create` adapter implementation.
 *
 * Lifted from `handlers/pr_create.ts` per Story 1.3. Mirrors `pr-create-github.ts`
 * — the handler dispatches to either depending on cwd platform.
 *
 * GitLab divergences from the GitHub flow:
 * - `glab mr create --yes` (non-interactive); `gh pr create` doesn't need it.
 * - `glab mr create` doesn't print a parseable URL on stdout — re-fetch via
 *   `glab api projects/<encoded>/merge_requests?source_branch=<head>` to get the
 *   canonical IID + web_url. (Was `glab mr view <head> -F json` until #383, but
 *   `-F` is not a valid flag on any glab subcommand in 1.36.0; see the
 *   `lib/gitlab-api.ts` header comment for the broader rationale.)
 * - `glab api projects/<encoded>` for default branch (no `--jq` flag — parse
 *   the JSON in-process).
 */

import { execSync } from 'child_process';
import { runArgv } from '../shared/error-norm.js';
import { resolveDefaultBranchGitlabSync } from './resolve-default-branch-gitlab.js';
import { resolveGitlabSelfSync } from './resolve-gitlab-self.js';
import { selfAssignLinkedIssuesGitlab, withLinkedAssign } from './self-assign-linked-issues.js';
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

function projectSlugEncoded(repo: string | undefined): string {
  return repo !== undefined ? repo.replace(/\//g, '%2F') : ':id';
}

function fetchOpenedMrBySourceBranch(
  head: string,
  cwd: string,
  repo: string | undefined,
): PrCreateResponse | null {
  // `glab api projects/.../merge_requests?source_branch=<head>&state=opened`
  // — the only reliable way to get JSON for an MR by source branch in
  // glab 1.36.0. Replaces the broken `glab mr view <head> -F json` (#383).
  const project = projectSlugEncoded(repo);
  const query = `source_branch=${encodeURIComponent(head)}&state=opened`;
  const result = runArgv(['glab', 'api', `projects/${project}/merge_requests?${query}`], cwd);
  if (result.exitCode !== 0 || result.stdout.trim().length === 0) return null;
  try {
    const arr = JSON.parse(result.stdout) as Array<{
      iid: number;
      web_url: string;
      state: string;
      source_branch: string;
      target_branch: string;
    }>;
    const mr = arr.find((m) => m.state === 'opened');
    if (!mr) return null;
    return {
      number: mr.iid,
      url: mr.web_url,
      state: 'open',
      head: mr.source_branch,
      base: mr.target_branch,
      created: false,
    };
  } catch {
    return null;
  }
}

function lookupGitlabMr(
  head: string,
  cwd: string,
  repo: string | undefined,
): PrCreateResponse | null {
  return fetchOpenedMrBySourceBranch(head, cwd, repo);
}

export async function prCreateGitlab(
  args: PrCreateArgs,
): Promise<AdapterResult<PrCreateResponse>> {
  try {
    const cwd = args.cwd ?? projectDir();
    const head = args.head ?? getCurrentBranch(cwd);
    const base = args.base && args.base.length > 0
      ? args.base
      : resolveDefaultBranchGitlabSync(args.repo, cwd);

    const createCmd = [
      'glab', 'mr', 'create',
      '--title', args.title,
      '--description', args.body,
      '--target-branch', base,
      '--source-branch', head,
      '--yes',
    ];
    // Self-assign at creation (#577). glab's `--assignee` takes a username (not
    // gh's `@me`), so resolve the current user first. Non-fatal: if resolution
    // returns null (unauthed/offline), the MR is created unassigned rather than
    // failing — a comfort must never block the create.
    const self = resolveGitlabSelfSync(cwd);
    if (self) createCmd.push('--assignee', self);
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

    // `glab mr create` doesn't print a URL on stdout. Re-fetch by
    // source-branch via `glab api` (#383: the previous `glab mr view -F json`
    // form rejected with "unknown shorthand flag" on every call, causing
    // pr_create to report failure even when the MR was created — callers then
    // fell back to a second `glab mr create` and hit a 409 conflict).
    const found = fetchOpenedMrBySourceBranch(head, cwd, args.repo);
    if (found === null) {
      return {
        ok: false,
        code: 'glab_mr_view_failed',
        error: `glab api lookup of MR for source_branch=${head} returned no opened MR after create; the create may have succeeded — verify in the GitLab UI`,
      };
    }
    // Additively self-assign the author to the issues this MR closes (#578).
    // Non-fatal — the MR already exists; a failed assign is a warning, not an error.
    const linked = selfAssignLinkedIssuesGitlab(args.body, cwd, args.repo);
    return {
      ok: true,
      data: withLinkedAssign({ ...found, created: true }, linked),
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
