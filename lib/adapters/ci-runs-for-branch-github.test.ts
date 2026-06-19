import { describe, test, expect, beforeEach } from 'bun:test';
import {
  installChildProcessMock,
  onExec,
  resetExecMock,
  execCalls,
} from '../test-support/mock-child-process.ts';
import type { AdapterResult, CiRunsForBranchResponse } from './types.ts';

// Subprocess-boundary tests for the GitHub ci_runs_for_branch adapter (R-15).
// Integration-level coverage (handler envelope + detectPlatform dispatch)
// stays in tests/ci_runs_for_branch.test.ts; this file owns the argv-shape
// and response-normalization assertions that prove the adapter speaks `gh`
// correctly.

interface ThrowableError extends Error {
  stderr?: string;
  stdout?: string;
  status?: number;
}

installChildProcessMock();

const { ciRunsForBranchGithub, githubStatusFlag } = await import(
  './ci-runs-for-branch-github.ts'
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
  const unquote = (cmd: string) => cmd.replace(/'([^']*)'/g, '$1');
  return execCalls().find((c) => c.includes(needle) || unquote(c).includes(needle)) ?? '';
}

beforeEach(() => {
  resetExecMock();
});

describe('ciRunsForBranchGithub — subprocess boundary', () => {
  // --- status-flag translation (pure) ---

  test('githubStatusFlag — argv for each status flag', () => {
    expect(githubStatusFlag('success')).toBe('success');
    expect(githubStatusFlag('failure')).toBe('failure');
    expect(githubStatusFlag('in_progress')).toBe('in_progress');
    expect(githubStatusFlag('all')).toBeNull();
  });

  // --- argv composition for each status flag ---

  test('argv: status=all omits --status', async () => {
    onExec('gh run list', JSON.stringify([]));

    await ciRunsForBranchGithub({
      branch: 'feature/88-ci',
      limit: 10,
      status: 'all',
    });

    const call = findCall('gh run list');
    expect(call).toContain('--branch');
    expect(call).toContain('feature/88-ci');
    expect(call).toContain('--limit');
    expect(call).toContain('10');
    expect(call).not.toContain('--status');
  });

  test('argv: status=success → --status success', async () => {
    onExec('gh run list', JSON.stringify([]));

    await ciRunsForBranchGithub({
      branch: 'feature/88-ci',
      limit: 5,
      status: 'success',
    });

    const call = findCall('gh run list');
    expect(call).toContain('--status');
    expect(call).toContain('success');
  });

  test('argv: status=failure → --status failure', async () => {
    onExec('gh run list', JSON.stringify([]));

    await ciRunsForBranchGithub({
      branch: 'main',
      limit: 10,
      status: 'failure',
    });

    const call = findCall('gh run list');
    expect(call).toContain('--status');
    expect(call).toContain('failure');
  });

  test('argv: status=in_progress → --status in_progress', async () => {
    onExec('gh run list', JSON.stringify([]));

    await ciRunsForBranchGithub({
      branch: 'main',
      limit: 10,
      status: 'in_progress',
    });

    const call = findCall('gh run list');
    expect(call).toContain('--status');
    expect(call).toContain('in_progress');
  });

  test('argv: --repo flag forwarded for cross-repo lookup', async () => {
    onExec('gh run list', JSON.stringify([]));

    await ciRunsForBranchGithub({
      branch: 'main',
      limit: 10,
      status: 'all',
      repo: 'other-org/other-repo',
    });

    const call = findCall('gh run list');
    expect(call).toContain('--repo');
    expect(call).toContain('other-org/other-repo');
  });

  test('argv: --json field list includes all expected fields', async () => {
    onExec('gh run list', JSON.stringify([]));

    await ciRunsForBranchGithub({
      branch: 'main',
      limit: 10,
      status: 'all',
    });

    const call = findCall('gh run list');
    expect(call).toContain('--json');
    for (const field of [
      'databaseId',
      'name',
      'status',
      'conclusion',
      'headSha',
      'url',
      'createdAt',
    ]) {
      expect(call).toContain(field);
    }
  });

  // --- normalizes response ---

  test('ci-runs-for-branch-github — normalizes response', async () => {
    onExec(
      'gh run list',
      JSON.stringify([
        {
          databaseId: 111,
          name: 'ci',
          status: 'completed',
          conclusion: 'success',
          headSha: 'abc123',
          url: 'https://github.com/org/repo/actions/runs/111',
          createdAt: '2026-04-07T12:00:00Z',
        },
        {
          databaseId: 110,
          name: 'lint',
          status: 'in_progress',
          conclusion: null,
          headSha: 'def456',
          url: 'https://github.com/org/repo/actions/runs/110',
          createdAt: '2026-04-07T11:00:00Z',
        },
      ]),
    );

    const result = await ciRunsForBranchGithub({
      branch: 'feature/88-ci',
      limit: 10,
      status: 'all',
    });

    expectOk(result);
    expect(result.data.runs).toHaveLength(2);
    expect(result.data.runs[0]).toEqual({
      run_id: 111,
      workflow_name: 'ci',
      status: 'completed',
      conclusion: 'success',
      sha: 'abc123',
      url: 'https://github.com/org/repo/actions/runs/111',
      created_at: '2026-04-07T12:00:00Z',
    });
    // Newest first preserved from CLI order
    expect(result.data.runs[0].run_id).toBeGreaterThan(result.data.runs[1].run_id);
    // in_progress run has null conclusion
    expect(result.data.runs[1].conclusion).toBeNull();
  });

  test('empty result — returns ok with empty runs array', async () => {
    onExec('gh run list', '[]');

    const result = await ciRunsForBranchGithub({
      branch: 'feature/99-never-ran',
      limit: 10,
      status: 'all',
    });

    expectOk(result);
    expect(result.data.runs).toEqual([]);
  });

  test('empty stdout — returns ok with empty runs array', async () => {
    onExec('gh run list', '');

    const result = await ciRunsForBranchGithub({
      branch: 'feature/99-never-ran',
      limit: 10,
      status: 'all',
    });

    expectOk(result);
    expect(result.data.runs).toEqual([]);
  });

  // --- error surface ---

  test('returns AdapterResult.error on gh failure (not thrown)', async () => {
    onExec('gh run list', () => {
      const err = new Error('gh: not authenticated') as ThrowableError;
      err.stderr = 'gh: not authenticated';
      err.status = 1;
      throw err;
    });

    const result = await ciRunsForBranchGithub({
      branch: 'main',
      limit: 10,
      status: 'all',
    });
    expectErr(result);
    expect(result.code).toBe('gh_run_list_failed');
    expect(result.error).toContain('gh run list failed');
  });
});
