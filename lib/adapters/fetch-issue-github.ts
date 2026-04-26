/**
 * GitHub `fetchIssue` adapter implementation — the Phase-2 keystone hybrid
 * sub-call (Story 2.1, #295).
 *
 * Single widest-reach platform operation in the retrofit: 10 downstream
 * handlers read the same normalized issue shape (`ibm`, `spec_get`,
 * `spec_validate_structure`, `spec_acceptance_criteria`, `spec_dependencies`,
 * `epic_sub_issues`, `wave_compute`, `wave_dependency_graph`, `wave_topology`,
 * `dod_load_manifest`). Landing the adapter first makes the Wave 2.2/2.3
 * handler lifts near-mechanical.
 *
 * Invokes `gh issue view --json number,title,state,url,body,labels` and
 * normalizes the response into an `AdapterIssue`. GitHub returns
 * `state: 'OPEN' | 'CLOSED'` already, but we uppercase defensively.
 */

import { execSync } from 'child_process';
import type {
  AdapterIssue,
  AdapterResult,
  FetchIssueArgs,
  IssueState,
} from './types.js';

interface GithubIssueLabel {
  name?: string;
}

interface GithubIssueViewResponse {
  number?: number;
  title?: string;
  state?: string;
  url?: string;
  body?: string;
  labels?: GithubIssueLabel[];
}

// Same charset as the sibling fetch-pr-state-github adapter — GitHub's
// owner/repo grammar. Defended at the adapter boundary so any caller gets the
// same protection without having to remember to validate themselves.
const GITHUB_REPO_SLUG = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function repoFlag(repo: string | undefined): string {
  if (repo === undefined) return '';
  if (!GITHUB_REPO_SLUG.test(repo)) {
    throw new Error(`fetchIssueGithub: invalid repo slug ${JSON.stringify(repo)}`);
  }
  return ` --repo ${repo}`;
}

function normalizeGithubIssueState(raw: string): IssueState {
  return raw.toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN';
}

export function fetchIssueGithubSync(num: number, repo?: string): AdapterIssue {
  const raw = execSync(
    `gh issue view ${num} --json number,title,state,url,body,labels${repoFlag(repo)}`,
    { encoding: 'utf8' },
  );
  const parsed = JSON.parse(raw) as GithubIssueViewResponse;
  const labels: string[] = Array.isArray(parsed.labels)
    ? parsed.labels
        .map((l) => (l && typeof l.name === 'string' ? l.name : ''))
        .filter((name) => name.length > 0)
    : [];
  return {
    number: typeof parsed.number === 'number' ? parsed.number : num,
    title: parsed.title ?? '',
    state: normalizeGithubIssueState(parsed.state ?? ''),
    url: parsed.url ?? '',
    body: parsed.body ?? '',
    labels,
  };
}

export async function fetchIssueGithub(
  args: FetchIssueArgs,
): Promise<AdapterResult<AdapterIssue>> {
  // Bound any exception (subprocess failure, JSON parse error, slug
  // validation) into a typed result — adapter callers must not have to
  // try/catch.
  try {
    const data = fetchIssueGithubSync(args.number, args.repo);
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      code: 'gh_issue_view_failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// `execSync` is intentionally re-imported above so that adapter-level test
// files can `mock.module('child_process', ...)` and intercept this module's
// subprocess calls.
void execSync;
