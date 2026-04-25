/**
 * Slim cross-platform PR/MR state fetcher.
 *
 * Used by `pr_merge` (for post-merge URL + sha lookup) and `pr_merge_wait`
 * (for polling until `state === 'merged'`). Intentionally narrower than
 * `handlers/pr_status.ts` — that handler returns rich check + mergeability
 * data; this lib returns only what the merge flow needs (state, url, sha).
 *
 * Why a separate lib instead of calling `pr_status` from `pr_merge_wait`:
 * - One exec call vs two (pr_status fetches checks separately).
 * - No JSON-of-JSON unwrap: handler responses are MCP envelopes wrapping
 *   JSON strings, awkward to consume from inside another handler.
 * - Decouples polling from rich-status concerns.
 *
 * Handlers that need the full status (`pr_status`, `pr_wait_ci`) keep their
 * existing wider queries; this module is the minimal-surface alternative for
 * the merge-confirmation use case.
 */

import { execSync } from 'child_process';
import { gitlabApiMr } from './glab.js';

export type PrState = 'open' | 'merged' | 'closed';

export interface PrStateInfo {
  state: PrState;
  url: string;
  mergeCommitSha?: string;
}

interface GithubPrViewResponse {
  state?: string;
  url?: string;
  mergeCommit?: { oid?: string } | null;
}

// Same charset as merge_queue_detect.ts and wave_previous_merged.ts — GitHub's
// owner/repo grammar. Defended at the lib boundary (not just at handler entry)
// so any future caller of fetchGithubPrState gets the same protection without
// having to remember to validate themselves.
const GITHUB_REPO_SLUG = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function repoFlag(repo: string | undefined): string {
  if (repo === undefined) return '';
  if (!GITHUB_REPO_SLUG.test(repo)) {
    throw new Error(`fetchGithubPrState: invalid repo slug ${JSON.stringify(repo)}`);
  }
  return ` --repo ${repo}`;
}

function parseSlugOpts(
  slug: string | undefined,
): { owner?: string; repo?: string } | undefined {
  if (slug === undefined) return undefined;
  const idx = slug.indexOf('/');
  if (idx <= 0 || idx === slug.length - 1) return undefined;
  return { owner: slug.slice(0, idx), repo: slug.slice(idx + 1) };
}

function normalizeGithubState(raw: string): PrState {
  const upper = raw.toUpperCase();
  if (upper === 'MERGED') return 'merged';
  if (upper === 'CLOSED') return 'closed';
  return 'open';
}

function normalizeGitlabState(raw: string): PrState {
  const lower = raw.toLowerCase();
  if (lower === 'merged') return 'merged';
  if (lower === 'closed') return 'closed';
  return 'open';
}

export function fetchGithubPrState(num: number, repo?: string): PrStateInfo {
  const raw = execSync(
    `gh pr view ${num} --json state,url,mergeCommit${repoFlag(repo)}`,
    { encoding: 'utf8' },
  );
  const parsed = JSON.parse(raw) as GithubPrViewResponse;
  return {
    state: normalizeGithubState(parsed.state ?? ''),
    url: parsed.url ?? '',
    mergeCommitSha: parsed.mergeCommit?.oid,
  };
}

export function fetchGitlabMrState(num: number, repo?: string): PrStateInfo {
  const mr = gitlabApiMr(num, parseSlugOpts(repo));
  return {
    state: normalizeGitlabState(mr.state ?? ''),
    url: mr.web_url ?? '',
    mergeCommitSha: mr.merge_commit_sha ?? undefined,
  };
}

export function fetchPrState(
  platform: 'github' | 'gitlab',
  num: number,
  repo?: string,
): PrStateInfo {
  return platform === 'github'
    ? fetchGithubPrState(num, repo)
    : fetchGitlabMrState(num, repo);
}
