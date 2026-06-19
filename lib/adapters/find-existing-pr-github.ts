/**
 * GitHub `findExistingPr` adapter implementation — the `wave_finalize`
 * idempotency hybrid sub-call (Story 2.23, #317).
 *
 * Lifted from `handlers/wave_finalize.ts`'s local `findExistingGithubPr`
 * helper. Returns the first PR matching `(head, base, state)` normalized to
 * the adapter's `NormalizedPr` shape, or `null` when no match exists.
 *
 * Invokes `gh pr list --head <h> --base <b> --state <s> --json
 * number,url,state,headRefName,baseRefName,title --limit 1 [--repo <slug>]`
 * and picks the first hit. Errors from `gh` are converted into a typed
 * `AdapterResult.error` — callers do not have to try/catch.
 *
 * State translation: gh accepts `open | closed | merged | all` directly — so
 * the caller-facing `'open' | 'closed' | 'merged'` vocabulary passes through
 * unchanged. The normalized state on the returned `NormalizedPr` is
 * lowercased to match the peer adapters' convention.
 */

import { execSync } from 'child_process';
import type {
  AdapterResult,
  FindExistingPrArgs,
  NormalizedPr,
} from './types.js';

interface GithubPrListEntry {
  number?: number;
  url?: string;
  state?: string;
  headRefName?: string;
  baseRefName?: string;
  title?: string;
}

// Same charset as the sibling fetch-pr-for-branch-github adapter — GitHub's
// owner/repo grammar. Defended at the adapter boundary so any caller
// (handler, peer adapter) gets the same protection without having to
// remember to validate themselves.
const GITHUB_REPO_SLUG = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

// `gh pr list --head/--base` will happily accept any non-empty string, but
// we refuse shell metacharacters defensively — these values originate
// outside the process boundary.
const BRANCH_CHARSET = /^[A-Za-z0-9._\-/]+$/;

function repoFlag(repo: string | undefined): string {
  if (repo === undefined) return '';
  if (!GITHUB_REPO_SLUG.test(repo)) {
    throw new Error(
      `findExistingPrGithub: invalid repo slug ${JSON.stringify(repo)}`,
    );
  }
  return ` --repo ${repo}`;
}

function validateBranch(label: string, value: string): void {
  if (!BRANCH_CHARSET.test(value)) {
    throw new Error(
      `findExistingPrGithub: invalid ${label} ${JSON.stringify(value)}`,
    );
  }
}

type GhState = 'open' | 'closed' | 'merged';

export function findExistingPrGithubSync(
  head: string,
  base: string,
  state: GhState,
  repo?: string,
  cwd?: string,
): NormalizedPr | null {
  validateBranch('head', head);
  validateBranch('base', base);
  // `cwd` defaults to undefined, which leaves execSync on `process.cwd()` —
  // identical to pre-#453 behavior. When the caller threads an explicit cwd
  // (e.g. wave_finalize against a worktree != CLAUDE_PROJECT_DIR), `gh` runs
  // there so the lookup hits the right repo.
  const raw = execSync(
    `gh pr list --head ${head} --base ${base} --state ${state} ` +
      `--json number,url,state,headRefName,baseRefName,title --limit 1${repoFlag(repo)}`,
    { encoding: 'utf8', cwd },
  );
  const parsed = JSON.parse(raw) as GithubPrListEntry[];
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const first = parsed[0];
  if (
    typeof first.number !== 'number' ||
    typeof first.url !== 'string' ||
    first.url.length === 0 ||
    typeof first.headRefName !== 'string' ||
    typeof first.baseRefName !== 'string'
  ) {
    return null;
  }
  return {
    number: first.number,
    title: typeof first.title === 'string' ? first.title : '',
    state: typeof first.state === 'string' ? first.state.toLowerCase() : state,
    head: first.headRefName,
    base: first.baseRefName,
    url: first.url,
  };
}

export async function findExistingPrGithub(
  args: FindExistingPrArgs,
): Promise<AdapterResult<NormalizedPr | null>> {
  // Bound any exception (subprocess failure, JSON parse error, slug
  // validation) into a typed result — adapter callers must not have to
  // try/catch.
  try {
    const data = findExistingPrGithubSync(
      args.head,
      args.base,
      args.state,
      args.repo,
      args.cwd,
    );
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
