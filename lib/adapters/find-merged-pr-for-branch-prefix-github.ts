/**
 * GitHub `findMergedPrForBranchPrefix` adapter implementation — hybrid
 * sub-call landed by Story 2.21 (#315).
 *
 * Lifted from `handlers/wave_reconcile_mrs.ts`'s local `queryGithubMergedPrs`
 * helper. Returns only what the reconcile flow needs: `{url}` (or `null` when
 * no merged PR has a source branch starting with `prefix`). Scans the merged
 * PR list client-side; GitHub's `gh pr list` has no native branch-prefix
 * filter.
 *
 * `limit` controls the size of the merged-list window scanned client-side.
 * The pre-migration handler hardcoded 50 (bug #282). Default is now 100 at
 * the handler layer; the adapter falls back to the same default if the caller
 * omits `limit` so direct adapter users see the widened behavior too.
 *
 * Invokes:
 *   gh pr list --state merged --json number,url,headRefName --limit <n>
 *   [--repo <slug>]
 *
 * Errors from `gh` (subprocess / JSON parse) are converted into a typed
 * `AdapterResult.error` — callers do not have to try/catch.
 */

import { execSync } from 'child_process';
import type {
  AdapterResult,
  FindMergedPrForBranchPrefixArgs,
} from './types.js';

interface GithubMergedPrEntry {
  number?: number;
  url?: string;
  headRefName?: string;
}

// Same charset as sibling adapters — GitHub's owner/repo grammar. Defended at
// the adapter boundary so any caller gets the same protection.
const GITHUB_REPO_SLUG = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function repoFlag(repo: string | undefined): string {
  if (repo === undefined) return '';
  if (!GITHUB_REPO_SLUG.test(repo)) {
    throw new Error(
      `findMergedPrForBranchPrefixGithub: invalid repo slug ${JSON.stringify(repo)}`,
    );
  }
  return ` --repo ${repo}`;
}

// The prefix ultimately lands in a client-side string match (never in argv)
// but we still refuse shell metacharacters defensively — the caller-supplied
// value originates outside the process boundary and this keeps the contract
// symmetric with sibling adapters like fetchPrForBranch.
const PREFIX_CHARSET = /^[A-Za-z0-9._\-/]+$/;

function validatePrefix(prefix: string): void {
  if (!PREFIX_CHARSET.test(prefix)) {
    throw new Error(
      `findMergedPrForBranchPrefixGithub: invalid prefix ${JSON.stringify(prefix)}`,
    );
  }
}

export const DEFAULT_LIMIT = 100;

export function findMergedPrForBranchPrefixGithubSync(
  prefix: string,
  limit: number,
  repo?: string,
): { url: string } | null {
  validatePrefix(prefix);
  if (!Number.isFinite(limit) || limit <= 0 || !Number.isInteger(limit)) {
    throw new Error(
      `findMergedPrForBranchPrefixGithub: invalid limit ${JSON.stringify(limit)}`,
    );
  }
  const raw = execSync(
    `gh pr list --state merged --json number,url,headRefName --limit ${limit}${repoFlag(repo)}`,
    { encoding: 'utf8' },
  );
  const parsed = JSON.parse(raw) as GithubMergedPrEntry[];
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const match = parsed.find(
    (pr) => typeof pr.headRefName === 'string' && pr.headRefName.startsWith(prefix),
  );
  if (!match || typeof match.url !== 'string' || match.url.length === 0) {
    return null;
  }
  return { url: match.url };
}

export async function findMergedPrForBranchPrefixGithub(
  args: FindMergedPrForBranchPrefixArgs,
): Promise<AdapterResult<{ url: string } | null>> {
  // Bound any exception (subprocess failure, JSON parse error, validation)
  // into a typed result — adapter callers must not have to try/catch.
  try {
    const limit = args.limit ?? DEFAULT_LIMIT;
    const data = findMergedPrForBranchPrefixGithubSync(args.prefix, limit, args.repo);
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      code: 'gh_pr_list_failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// `execSync` is intentionally re-imported above so that adapter-level test
// files can `mock.module('child_process', ...)` and intercept this module's
// subprocess calls.
void execSync;
