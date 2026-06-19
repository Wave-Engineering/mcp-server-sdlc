import { describe, test, expect, beforeEach } from 'bun:test';
import type { AdapterResult, CiRunsForBranchResponse } from './types.ts';
import {
  installChildProcessMock,
  onExec as on,
  resetExecMock,
  execCalls,
} from '../test-support/mock-child-process.ts';

// Subprocess-boundary tests for the GitLab ci_runs_for_branch adapter (R-15).
// Integration-level coverage (handler envelope + detectPlatform dispatch)
// stays in tests/ci_runs_for_branch.test.ts; this file owns the argv-shape
// and response-normalization assertions.
//
// The adapter routes its subprocess through `gitlabApiCiList` in
// `lib/gitlab-api.ts`. We mock `child_process.execSync` directly and register
// the `git remote get-url origin` response in the same registry so
// `parseRepoSlug`'s call lands on our mock. Avoiding `mock.module` on
// `../shared/parse-repo-slug.js` keeps the process-global mock registry
// clean — other gitlab adapter tests (ci-run-logs-gitlab) break when
// `parseRepoSlug` is stubbed out wholesale (Bun mock.module pollution —
// last-write-wins).

interface ThrowableError extends Error {
  stderr?: string;
  stdout?: string;
  status?: number;
}

installChildProcessMock();

const { ciRunsForBranchGitlab, gitlabStatusFlag } = await import(
  './ci-runs-for-branch-gitlab.ts'
);

function expectOk(
  r: AdapterResult<CiRunsForBranchResponse>,
): asserts r is { ok: true; data: CiRunsForBranchResponse } {
  if (!('ok' in r) || !r.ok) {
    throw new Error(`expected ok result, got ${JSON.stringify(r)}`);
  }
}

function expectErr(
  r: AdapterResult<CiRunsForBranchResponse>,
): asserts r is { ok: false; error: string; code: string } {
  if (!('ok' in r) || r.ok) {
    throw new Error(`expected error result, got ${JSON.stringify(r)}`);
  }
}

function findCall(needle: string): string {
  return execCalls().find((c) => c.includes(needle)) ?? '';
}

beforeEach(() => {
  resetExecMock();
  // Default origin URL — gives parseRepoSlug an `org/repo` slug unless a test
  // overrides it.
  on('git remote get-url origin', 'https://gitlab.com/org/repo.git\n');
});

describe('ciRunsForBranchGitlab — subprocess boundary', () => {
  // --- status-flag translation (pure) ---

  test('gitlabStatusFlag — argv for each status flag', () => {
    expect(gitlabStatusFlag('success')).toBe('success');
    expect(gitlabStatusFlag('failure')).toBe('failed');
    expect(gitlabStatusFlag('in_progress')).toBe('running');
    expect(gitlabStatusFlag('all')).toBeNull();
  });

  // --- argv composition ---

  test('argv: status=all uses per_page=<limit>', async () => {
    on('glab api projects/org%2Frepo/pipelines?ref=main&per_page=10', '[]');

    await ciRunsForBranchGitlab({
      branch: 'main',
      limit: 10,
      status: 'all',
    });

    const call = findCall('glab api');
    expect(call).toContain('projects/org%2Frepo/pipelines');
    expect(call).toContain('ref=main');
    expect(call).toContain('per_page=10');
  });

  test('argv: status filter applied client-side; uses per_page=<limit*3>', async () => {
    // status=success fetches 3x and filters client-side
    on(
      'glab api projects/org%2Frepo/pipelines?ref=main&per_page=15',
      JSON.stringify([
        {
          id: 1,
          status: 'success',
          sha: 'aaa',
          ref: 'main',
          web_url: 'https://gitlab.com/org/repo/-/pipelines/1',
          created_at: '2026-04-07T12:00:00Z',
          source: 'push',
        },
        {
          id: 2,
          status: 'failed',
          sha: 'bbb',
          ref: 'main',
          web_url: 'https://gitlab.com/org/repo/-/pipelines/2',
          created_at: '2026-04-07T11:00:00Z',
          source: 'push',
        },
      ]),
    );

    const result = await ciRunsForBranchGitlab({
      branch: 'main',
      limit: 5,
      status: 'success',
    });

    expectOk(result);
    expect(result.data.runs).toHaveLength(1);
    expect(result.data.runs[0].run_id).toBe(1);

    const call = findCall('per_page=15');
    expect(call).toContain('per_page=15');
  });

  test('argv: explicit repo routes to encoded explicit slug', async () => {
    on('glab api projects/other-org%2Fother-repo/pipelines?ref=', '[]');

    await ciRunsForBranchGitlab({
      branch: 'main',
      limit: 10,
      status: 'all',
      repo: 'other-org/other-repo',
    });

    const call = findCall('glab api');
    expect(call).toContain('projects/other-org%2Fother-repo/pipelines');
    expect(call).not.toContain('projects/org%2Frepo/pipelines');
  });

  // --- normalizes response ---

  test('ci-runs-for-branch-gitlab — normalizes response', async () => {
    on(
      'glab api projects/org%2Frepo/pipelines?ref=feature%2F88-ci&per_page=10',
      JSON.stringify([
        {
          id: 5001,
          status: 'success',
          sha: 'gitlabsha1',
          ref: 'feature/88-ci',
          web_url: 'https://gitlab.com/org/repo/-/pipelines/5001',
          created_at: '2026-04-07T12:00:00Z',
          source: 'push',
        },
        {
          id: 5000,
          status: 'running',
          sha: 'gitlabsha0',
          ref: 'feature/88-ci',
          web_url: 'https://gitlab.com/org/repo/-/pipelines/5000',
          created_at: '2026-04-07T11:00:00Z',
          source: 'push',
        },
        {
          id: 4999,
          status: 'failed',
          sha: 'gitlabsha-1',
          ref: 'feature/88-ci',
          web_url: 'https://gitlab.com/org/repo/-/pipelines/4999',
          created_at: '2026-04-07T10:00:00Z',
          // no source — falls back to 'pipeline'
        },
      ]),
    );

    const result = await ciRunsForBranchGitlab({
      branch: 'feature/88-ci',
      limit: 10,
      status: 'all',
    });

    expectOk(result);
    expect(result.data.runs).toHaveLength(3);

    // Success → terminal → conclusion === status
    expect(result.data.runs[0]).toEqual({
      run_id: 5001,
      workflow_name: 'push',
      status: 'success',
      conclusion: 'success',
      sha: 'gitlabsha1',
      url: 'https://gitlab.com/org/repo/-/pipelines/5001',
      created_at: '2026-04-07T12:00:00Z',
    });

    // Running → non-terminal → conclusion null
    expect(result.data.runs[1].conclusion).toBeNull();
    expect(result.data.runs[1].status).toBe('running');

    // Failed → terminal → conclusion === status === 'failed'
    expect(result.data.runs[2].conclusion).toBe('failed');
    // Fallback workflow_name when source absent
    expect(result.data.runs[2].workflow_name).toBe('pipeline');
  });

  test('truncates to limit after client-side filter', async () => {
    on(
      'glab api projects/org%2Frepo/pipelines?ref=main&per_page=6',
      JSON.stringify([
        { id: 1, status: 'success', sha: 'a', ref: 'main', web_url: 'u1', created_at: '1', source: 'push' },
        { id: 2, status: 'success', sha: 'b', ref: 'main', web_url: 'u2', created_at: '2', source: 'push' },
        { id: 3, status: 'success', sha: 'c', ref: 'main', web_url: 'u3', created_at: '3', source: 'push' },
        { id: 4, status: 'success', sha: 'd', ref: 'main', web_url: 'u4', created_at: '4', source: 'push' },
      ]),
    );

    const result = await ciRunsForBranchGitlab({
      branch: 'main',
      limit: 2,
      status: 'success',
    });

    expectOk(result);
    expect(result.data.runs).toHaveLength(2);
  });

  test('empty pipeline list — returns ok with empty runs array', async () => {
    on('glab api projects/org%2Frepo/pipelines?ref=', '[]');

    const result = await ciRunsForBranchGitlab({
      branch: 'feature/99-never-ran',
      limit: 10,
      status: 'all',
    });

    expectOk(result);
    expect(result.data.runs).toEqual([]);
  });

  // --- error surface ---

  test('returns AdapterResult.error on glab failure (not thrown)', async () => {
    on('glab api', () => {
      const err = new Error('glab: 401 unauthorized') as ThrowableError;
      err.stderr = 'glab: 401 unauthorized';
      err.status = 1;
      throw err;
    });

    const result = await ciRunsForBranchGitlab({
      branch: 'main',
      limit: 10,
      status: 'all',
    });
    expectErr(result);
    expect(result.code).toBe('glab_api_pipelines_failed');
    expect(result.error).toContain('401 unauthorized');
  });
});
