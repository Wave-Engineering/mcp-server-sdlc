/**
 * GitHub `fetchPrForBranch` adapter implementation — the `ibm` keystone
 * hybrid sub-call (Story 2.18, #312).
 *
 * Lifted from `handlers/ibm.ts`'s local `getGithubPrUrl` helper. Returns
 * only what the Issue→Branch→PR workflow check needs: `{url, number}` (or
 * `null` when no PR matches). The existing PR list adapter returns a richer
 * `NormalizedPr[]` — this sub-call is deliberately narrower so the handler
 * shrinks to a thin dispatcher and never touches `gh`/`glab` directly.
 *
 * Invokes `gh pr list --head <branch> --state <state> --json number,url
 * [--repo <slug>]` and picks the first hit (or returns `null` on empty
 * result). Errors from `gh` are converted into a typed
 * `AdapterResult.error` — callers do not have to try/catch.
 */

import { execSync } from 'child_process';
import type {
  AdapterResult,
  FetchPrForBranchArgs,
  PrForBranchRef,
} from './types.js';

interface GithubPrListEntry {
  number?: number;
  url?: string;
}

// Same charset as the sibling fetch-pr-state-github adapter — GitHub's
// owner/repo grammar. Defended at the adapter boundary so any caller
// (handler, peer adapter) gets the same protection without having to
// remember to validate themselves.
const GITHUB_REPO_SLUG = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

// gh pr list accepts `open | closed | merged | all` directly — same
// vocabulary as the handler-facing arg, so no translation is needed.
type GhState = 'open' | 'closed' | 'merged' | 'all';

function repoFlag(repo: string | undefined): string {
  if (repo === undefined) return '';
  if (!GITHUB_REPO_SLUG.test(repo)) {
    throw new Error(
      `fetchPrForBranchGithub: invalid repo slug ${JSON.stringify(repo)}`,
    );
  }
  return ` --repo ${repo}`;
}

// `gh pr list --head` will happily accept any non-empty string, but we
// refuse shell metacharacters defensively — the branch value originates
// outside the process boundary.
const BRANCH_CHARSET = /^[A-Za-z0-9._\-/]+$/;

function validateBranch(branch: string): void {
  if (!BRANCH_CHARSET.test(branch)) {
    throw new Error(
      `fetchPrForBranchGithub: invalid branch ${JSON.stringify(branch)}`,
    );
  }
}

export function fetchPrForBranchGithubSync(
  branch: string,
  state: GhState,
  repo?: string,
): PrForBranchRef | null {
  validateBranch(branch);
  const raw = execSync(
    `gh pr list --head ${branch} --state ${state} --json number,url${repoFlag(repo)}`,
    { encoding: 'utf8' },
  );
  const parsed = JSON.parse(raw) as GithubPrListEntry[];
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const first = parsed[0];
  if (
    typeof first.number !== 'number' ||
    typeof first.url !== 'string' ||
    first.url.length === 0
  ) {
    return null;
  }
  return { number: first.number, url: first.url };
}

export async function fetchPrForBranchGithub(
  args: FetchPrForBranchArgs,
): Promise<AdapterResult<PrForBranchRef | null>> {
  // Bound any exception (subprocess failure, JSON parse error, slug
  // validation) into a typed result — adapter callers must not have to
  // try/catch.
  try {
    const state: GhState = args.state ?? 'open';
    const data = fetchPrForBranchGithubSync(args.branch, state, args.repo);
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
