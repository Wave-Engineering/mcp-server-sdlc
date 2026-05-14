import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { AdapterResult, PrMergeResponse } from './types.ts';

// Subprocess-boundary tests for the GitLab pr_merge adapter (R-15).
// Integration-level coverage stays in tests/pr_merge.test.ts.

interface ThrowableError extends Error {
  stderr?: string;
  stdout?: string;
  status?: number;
}

let execRegistry: Array<{ match: string; respond: string | (() => string) }> = [];
let execCalls: string[] = [];

function unquote(cmd: string): string {
  return cmd.replace(/'([^']*)'/g, '$1');
}

const mockExecSync = mock((cmd: string, _opts?: unknown) => {
  execCalls.push(cmd);
  const flat = unquote(cmd);
  for (const { match, respond } of execRegistry) {
    if (cmd.includes(match) || flat.includes(match)) {
      return typeof respond === 'function' ? respond() : respond;
    }
  }
  const err = new Error(`Unexpected exec: ${cmd}`) as ThrowableError;
  err.stderr = `Unexpected exec: ${cmd}`;
  err.status = 127;
  throw err;
});

mock.module('child_process', () => ({ execSync: mockExecSync }));

const { prMergeGitlab } = await import('./pr-merge-gitlab.ts');

function on(match: string, respond: string | (() => string)): void {
  execRegistry.push({ match, respond });
}

function expectOk(
  r: AdapterResult<PrMergeResponse>,
): asserts r is { ok: true; data: PrMergeResponse } {
  if (!('ok' in r) || !r.ok) {
    throw new Error(`expected ok result, got ${JSON.stringify(r)}`);
  }
}

function expectErr(
  r: AdapterResult<PrMergeResponse>,
): asserts r is { ok: false; error: string; code: string } {
  if (!('ok' in r) || r.ok) {
    throw new Error(`expected error result, got ${JSON.stringify(r)}`);
  }
}

function findCall(needle: string): string {
  return execCalls.find((c) => c.includes(needle) || unquote(c).includes(needle)) ?? '';
}

beforeEach(() => {
  execRegistry = [];
  execCalls = [];
  // Story 1.11 routes prMergeGitlab's post-merge state lookup through
  // getAdapter().fetchPrState(...) — which calls detectPlatform(). Stub the
  // cwd-remote so detection picks GitLab and the routed call lands on
  // fetchPrStateGitlab (matching this adapter's intent).
  on('git remote get-url origin', 'https://gitlab.com/org/repo.git\n');
});

describe('prMergeGitlab — subprocess boundary', () => {
  test('direct merge returns aggregate envelope', async () => {
    on('glab mr merge 17 --squash --remove-source-branch --yes', '');
    on(
      'glab api projects/org%2Frepo/merge_requests/17',
      JSON.stringify({
        iid: 17,
        state: 'merged',
        source_branch: 'feature/test',
        target_branch: 'main',
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/17',
        labels: [],
        merge_commit_sha: 'deadbeef1234',
      }),
    );

    const result = await prMergeGitlab({ number: 17, repo: 'org/repo' });
    expectOk(result);
    expect(result.data).toEqual({
      number: 17,
      enrolled: true,
      merged: true,
      merge_method: 'direct_squash',
      queue: { enabled: false, position: null, enforced: false },
      pr_state: 'MERGED',
      url: 'https://gitlab.com/org/repo/-/merge_requests/17',
      merge_commit_sha: 'deadbeef1234',
      warnings: [],
      queue_fallback: false,
      graphql_fallback: false,
    });
    // No `gh api graphql` call should ever fire on the GitLab path.
    expect(execCalls.find((c) => c.includes('gh api graphql'))).toBeUndefined();
  });

  test('skip_train is silently dropped — merge proceeds with warning (#423)', async () => {
    on('glab mr merge 9 --squash --remove-source-branch --yes', '');
    on(
      'glab api projects/org%2Frepo/merge_requests/9',
      JSON.stringify({
        iid: 9,
        state: 'merged',
        source_branch: 'feature/train',
        target_branch: 'main',
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/9',
        labels: [],
        merge_commit_sha: 'abc123def456',
      }),
    );

    const result = await prMergeGitlab({ number: 9, skip_train: true, repo: 'org/repo' });
    expectOk(result);
    expect(result.data.merged).toBe(true);
    expect(result.data.warnings).toContain(
      'skip_train ignored on GitLab — merge trains are auto-managed at the project level',
    );
  });

  test('skip_train omitted — no warning in response', async () => {
    on('glab mr merge 10 --squash --remove-source-branch --yes', '');
    on(
      'glab api projects/org%2Frepo/merge_requests/10',
      JSON.stringify({
        iid: 10,
        state: 'merged',
        source_branch: 'feature/no-train',
        target_branch: 'main',
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/10',
        labels: [],
        merge_commit_sha: 'deadbeef0000',
      }),
    );

    const result = await prMergeGitlab({ number: 10, repo: 'org/repo' });
    expectOk(result);
    expect(result.data.warnings).toEqual([]);
  });

  test('returns AdapterResult{ok:false, code} on glab failure (not thrown)', async () => {
    on('glab mr merge 9 --squash --remove-source-branch --yes', () => {
      const err = new Error('merge request cannot be merged') as ThrowableError;
      err.stderr = 'merge request has conflicts\n';
      throw err;
    });

    const result = await prMergeGitlab({ number: 9, repo: 'org/repo' });
    expectErr(result);
    expect(result.code).toBe('glab_mr_merge_failed');
    expect(result.error).toContain('glab mr merge failed');
  });

  test('squash message → --squash-message inline', async () => {
    on('glab mr merge 14 --squash --remove-source-branch --yes', '');
    on(
      'glab api projects/org%2Frepo/merge_requests/14',
      JSON.stringify({
        iid: 14,
        state: 'merged',
        source_branch: 'feature/fix',
        target_branch: 'main',
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/14',
        labels: [],
        merge_commit_sha: 'f00dbabe',
      }),
    );

    const result = await prMergeGitlab({
      number: 14,
      squash_message: 'fix: patch',
      repo: 'org/repo',
    });
    expectOk(result);
    const mergeCall = findCall('glab mr merge 14');
    expect(mergeCall).toContain("--squash-message 'fix: patch'");
  });

  test('-R flag forwarded when args.repo provided (GitLab uses -R, not --repo)', async () => {
    on('glab mr merge 17 --squash --remove-source-branch --yes', '');
    on(
      'glab api projects/target-org%2Ftarget-repo/merge_requests/17',
      JSON.stringify({
        iid: 17,
        state: 'merged',
        source_branch: 'feature/test',
        target_branch: 'main',
        web_url: 'https://gitlab.com/target-org/target-repo/-/merge_requests/17',
        labels: [],
        merge_commit_sha: 'deadbeef',
      }),
    );

    const result = await prMergeGitlab({
      number: 17,
      repo: 'target-org/target-repo',
    });
    expectOk(result);
    const mergeCall = findCall('glab mr merge 17');
    expect(mergeCall).toContain('-R target-org/target-repo');
    const apiCall = findCall('glab api projects/');
    expect(apiCall).toContain('target-org%2Ftarget-repo');
  });
});
