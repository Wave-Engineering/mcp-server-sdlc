import { describe, test, expect, beforeEach } from 'bun:test';
import {
  installChildProcessMock,
  onExec,
  resetExecMock,
  execCalls,
} from '../test-support/mock-child-process.ts';
import type { AdapterResult, CiRunStatusResponse } from './types.ts';

// Subprocess-boundary tests for the GitHub ci_run_status adapter (R-15).
// Integration-level coverage (handler envelope + detectPlatform dispatch)
// stays in tests/ci_run_status.test.ts; this file owns the argv-shape and
// enum-normalization assertions that prove the adapter speaks `gh` correctly.

interface ThrowableError extends Error {
  stderr?: string;
  stdout?: string;
  status?: number;
}

installChildProcessMock();

const { ciRunStatusGithub } = await import('./ci-run-status-github.ts');

function expectOk(
  r: AdapterResult<CiRunStatusResponse>,
): asserts r is { ok: true; data: CiRunStatusResponse } {
  if (!('ok' in r) || !r.ok) {
    throw new Error(`expected ok result, got ${JSON.stringify(r)}`);
  }
}

function expectErr(
  r: AdapterResult<CiRunStatusResponse>,
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

describe('ciRunStatusGithub — subprocess boundary', () => {
  // --- argv + normalization for the three status enum families ---

  test('argv: --branch selector for non-SHA ref; normalizes success', async () => {
    onExec(
      'gh run list',
      JSON.stringify([
        {
          databaseId: 12345,
          name: 'CI',
          status: 'completed',
          conclusion: 'success',
          url: 'https://github.com/org/repo/actions/runs/12345',
          headBranch: 'feature/42-thing',
          headSha: 'abcdef0123456789abcdef0123456789abcdef01',
          createdAt: '2025-01-01T00:00:00Z',
          updatedAt: '2025-01-01T00:05:00Z',
        },
      ]),
    );

    const result = await ciRunStatusGithub({ ref: 'feature/42-thing' });
    expectOk(result);
    const run = result.data!;
    expect(run.run_id).toBe(12345);
    expect(run.workflow_name).toBe('CI');
    expect(run.status).toBe('completed');
    expect(run.conclusion).toBe('success');
    expect(run.url).toBe('https://github.com/org/repo/actions/runs/12345');
    expect(run.ref).toBe('feature/42-thing');
    expect(run.sha).toBe('abcdef0123456789abcdef0123456789abcdef01');
    expect(run.created_at).toBe('2025-01-01T00:00:00Z');
    expect(run.finished_at).toBe('2025-01-01T00:05:00Z');

    const call = findCall('gh run list');
    expect(call).toContain('--branch');
    expect(call).toContain('feature/42-thing');
    expect(call).not.toContain('--commit');
    expect(call).toContain('--limit');
    expect(call).toContain('1');
    expect(call).toContain('--json');
    expect(call).toContain('databaseId');
  });

  test('argv: --commit selector for 40-char hex SHA; in_progress → finished_at null', async () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    onExec(
      'gh run list',
      JSON.stringify([
        {
          databaseId: 7777,
          name: 'Build',
          status: 'in_progress',
          conclusion: null,
          url: 'https://github.com/org/repo/actions/runs/7777',
          headBranch: 'main',
          headSha: sha,
          createdAt: '2025-02-02T10:00:00Z',
          updatedAt: '2025-02-02T10:03:00Z',
        },
      ]),
    );

    const result = await ciRunStatusGithub({ ref: sha });
    expectOk(result);
    const run = result.data!;
    expect(run.run_id).toBe(7777);
    expect(run.status).toBe('in_progress');
    expect(run.conclusion).toBeNull();
    // in_progress → finished_at null
    expect(run.finished_at).toBeNull();
    expect(run.sha).toBe(sha);

    const call = findCall('gh run list');
    expect(call).toContain('--commit');
    expect(call).toContain(sha);
    expect(call).not.toContain('--branch');
  });

  test('normalizes failure conclusion for completed run', async () => {
    onExec(
      'gh run list',
      JSON.stringify([
        {
          databaseId: 42,
          name: 'Test',
          status: 'completed',
          conclusion: 'failure',
          url: 'https://github.com/o/r/actions/runs/42',
          headBranch: 'main',
          headSha: '1111111111111111111111111111111111111111',
          createdAt: '2025-03-03T00:00:00Z',
          updatedAt: '2025-03-03T00:02:00Z',
        },
      ]),
    );

    const result = await ciRunStatusGithub({ ref: 'main' });
    expectOk(result);
    expect(result.data!.status).toBe('completed');
    expect(result.data!.conclusion).toBe('failure');
    expect(result.data!.finished_at).toBe('2025-03-03T00:02:00Z');
  });

  test('normalizes GitHub-specific conclusions (neutral/action_required/stale → failure)', async () => {
    onExec(
      'gh run list',
      JSON.stringify([
        {
          databaseId: 50,
          name: 'Nightly',
          status: 'completed',
          conclusion: 'action_required',
          url: 'https://github.com/o/r/actions/runs/50',
          headBranch: 'main',
          headSha: '2222222222222222222222222222222222222222',
          createdAt: '2025-04-04T00:00:00Z',
          updatedAt: '2025-04-04T00:01:00Z',
        },
      ]),
    );

    const result = await ciRunStatusGithub({ ref: 'main' });
    expectOk(result);
    expect(result.data!.conclusion).toBe('failure');
  });

  test('normalizes queued-family statuses (waiting/pending/requested → queued)', async () => {
    onExec(
      'gh run list',
      JSON.stringify([
        {
          databaseId: 60,
          name: 'CI',
          status: 'waiting',
          conclusion: null,
          url: 'https://github.com/o/r/actions/runs/60',
          headBranch: 'main',
          headSha: '3333333333333333333333333333333333333333',
          createdAt: '2025-05-05T00:00:00Z',
          updatedAt: '2025-05-05T00:00:00Z',
        },
      ]),
    );

    const result = await ciRunStatusGithub({ ref: 'main' });
    expectOk(result);
    expect(result.data!.status).toBe('queued');
    expect(result.data!.finished_at).toBeNull();
  });

  test('--workflow flag forwarded', async () => {
    onExec(
      'gh run list',
      JSON.stringify([
        {
          databaseId: 999,
          name: 'Deploy',
          status: 'completed',
          conclusion: 'success',
          url: 'https://github.com/o/r/actions/runs/999',
          headBranch: 'main',
          headSha: 'fedcba9876543210fedcba9876543210fedcba98',
          createdAt: '2025-06-06T00:00:00Z',
          updatedAt: '2025-06-06T00:02:00Z',
        },
      ]),
    );

    const result = await ciRunStatusGithub({ ref: 'main', workflow_name: 'Deploy' });
    expectOk(result);
    expect(result.data!.workflow_name).toBe('Deploy');

    const call = findCall('gh run list');
    expect(call).toContain('--workflow');
    expect(call).toContain('Deploy');
  });

  test('--repo flag forwarded for cross-repo lookup', async () => {
    onExec('gh run list', JSON.stringify([]));

    await ciRunStatusGithub({ ref: 'main', repo: 'other-org/other-repo' });
    const call = findCall('gh run list');
    expect(call).toContain('--repo');
    expect(call).toContain('other-org/other-repo');
  });

  // --- null return when no matching run ---

  test('null return when `gh` returns an empty array', async () => {
    onExec('gh run list', JSON.stringify([]));

    const result = await ciRunStatusGithub({ ref: 'branch-no-runs' });
    expectOk(result);
    expect(result.data).toBeNull();
  });

  test('null return when `gh` returns empty stdout', async () => {
    onExec('gh run list', '');

    const result = await ciRunStatusGithub({ ref: 'branch-no-runs' });
    expectOk(result);
    expect(result.data).toBeNull();
  });

  // --- error: gh failure surfaces as AdapterResult.error, never thrown ---

  test('returns AdapterResult.error on gh failure (not thrown)', async () => {
    onExec('gh run list', () => {
      const err = new Error('gh: not authenticated') as ThrowableError;
      err.stderr = 'gh: not authenticated';
      err.status = 1;
      throw err;
    });

    const result = await ciRunStatusGithub({ ref: 'main' });
    expectErr(result);
    expect(result.code).toBe('gh_run_list_failed');
    expect(result.error).toContain('gh run list failed');
  });
});
