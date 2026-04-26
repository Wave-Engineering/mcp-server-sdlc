import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { AdapterResult, CiFailedJobsResponse } from './types.ts';

// Subprocess-boundary tests for the GitHub ci_failed_jobs adapter (R-15).
// Integration-level coverage (handler dispatch, envelope shape) stays in
// tests/ci_failed_jobs.test.ts; this file owns the argv-shape and
// response-parsing assertions that prove the adapter speaks `gh` correctly.

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

const { ciFailedJobsGithub } = await import('./ci-failed-jobs-github.ts');

function on(match: string, respond: string | (() => string)): void {
  execRegistry.push({ match, respond });
}

function expectOk(
  r: AdapterResult<CiFailedJobsResponse>,
): asserts r is { ok: true; data: CiFailedJobsResponse } {
  if (!('ok' in r) || !r.ok) {
    throw new Error(`expected ok result, got ${JSON.stringify(r)}`);
  }
}

function expectErr(
  r: AdapterResult<CiFailedJobsResponse>,
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
});

describe('ciFailedJobsGithub — subprocess boundary', () => {
  test('argv: gh run view <id> --json jobs', async () => {
    on('gh run view', JSON.stringify({ jobs: [] }));

    const result = await ciFailedJobsGithub({ run_id: 12345 });
    expectOk(result);

    const call = findCall('gh run view');
    expect(call).toContain('12345');
    expect(call).toContain('--json');
    expect(call).toContain('jobs');
    // No --repo flag absent an explicit slug.
    expect(call).not.toContain('--repo');
  });

  test('normalizes failed jobs — mixed success/failure/timed_out', async () => {
    on(
      'gh run view',
      JSON.stringify({
        jobs: [
          {
            databaseId: 101,
            name: 'lint',
            status: 'completed',
            conclusion: 'success',
            startedAt: '2025-01-01T00:00:00Z',
            completedAt: '2025-01-01T00:01:00Z',
            url: 'https://github.com/o/r/actions/runs/12345/job/101',
          },
          {
            databaseId: 102,
            name: 'test',
            status: 'completed',
            conclusion: 'failure',
            startedAt: '2025-01-01T00:00:00Z',
            completedAt: '2025-01-01T00:02:00Z',
            url: 'https://github.com/o/r/actions/runs/12345/job/102',
          },
          {
            databaseId: 103,
            name: 'build',
            status: 'completed',
            conclusion: 'timed_out',
            startedAt: '2025-01-01T00:00:00Z',
            completedAt: '2025-01-01T00:10:00Z',
            url: 'https://github.com/o/r/actions/runs/12345/job/103',
          },
        ],
      }),
    );

    const result = await ciFailedJobsGithub({ run_id: 12345 });
    expectOk(result);
    expect(result.data.failed_jobs).toHaveLength(2);
    expect(result.data.failed_jobs[0]).toEqual({
      job_id: 102,
      name: 'test',
      stage: null,
      conclusion: 'failure',
      started_at: '2025-01-01T00:00:00Z',
      finished_at: '2025-01-01T00:02:00Z',
      url: 'https://github.com/o/r/actions/runs/12345/job/102',
    });
    expect(result.data.failed_jobs[1]).toEqual({
      job_id: 103,
      name: 'build',
      stage: null,
      conclusion: 'timed_out',
      started_at: '2025-01-01T00:00:00Z',
      finished_at: '2025-01-01T00:10:00Z',
      url: 'https://github.com/o/r/actions/runs/12345/job/103',
    });
  });

  test('skips in-progress jobs (status !== "completed")', async () => {
    on(
      'gh run view',
      JSON.stringify({
        jobs: [
          {
            databaseId: 20,
            name: 'still-running',
            status: 'in_progress',
            conclusion: null,
            startedAt: '2025-01-01T00:00:00Z',
            completedAt: null,
            url: 'https://github.com/o/r/actions/runs/555/job/20',
          },
          {
            databaseId: 21,
            name: 'done-failed',
            status: 'completed',
            conclusion: 'failure',
            startedAt: '2025-01-01T00:00:00Z',
            completedAt: '2025-01-01T00:02:00Z',
            url: 'https://github.com/o/r/actions/runs/555/job/21',
          },
        ],
      }),
    );

    const result = await ciFailedJobsGithub({ run_id: 555 });
    expectOk(result);
    expect(result.data.failed_jobs).toHaveLength(1);
    expect(result.data.failed_jobs[0].name).toBe('done-failed');
  });

  test('all success returns empty list', async () => {
    on(
      'gh run view',
      JSON.stringify({
        jobs: [
          {
            databaseId: 1,
            name: 'lint',
            status: 'completed',
            conclusion: 'success',
            startedAt: '2025-01-01T00:00:00Z',
            completedAt: '2025-01-01T00:01:00Z',
            url: 'https://github.com/o/r/actions/runs/999/job/1',
          },
        ],
      }),
    );

    const result = await ciFailedJobsGithub({ run_id: 999 });
    expectOk(result);
    expect(result.data.failed_jobs).toEqual([]);
  });

  test('missing jobs field defaults to empty list', async () => {
    on('gh run view', JSON.stringify({}));

    const result = await ciFailedJobsGithub({ run_id: 1 });
    expectOk(result);
    expect(result.data.failed_jobs).toEqual([]);
  });

  test('returns AdapterResult.error on gh failure (not thrown)', async () => {
    on('gh run view', () => {
      const err = new Error('gh: run not found') as ThrowableError;
      err.stderr = 'gh: run not found';
      err.status = 1;
      throw err;
    });

    const result = await ciFailedJobsGithub({ run_id: 404 });
    expectErr(result);
    expect(result.code).toBe('gh_run_view_failed');
    expect(result.error).toContain('gh run view failed');
  });

  test('--repo flag forwarded when args.repo provided', async () => {
    on('gh run view', JSON.stringify({ jobs: [] }));

    await ciFailedJobsGithub({ run_id: 777, repo: 'other-org/other-repo' });
    const call = findCall('gh run view');
    expect(call).toContain('--repo');
    expect(call).toContain('other-org/other-repo');
  });

  test('missing databaseId / missing fields coerce to safe defaults', async () => {
    on(
      'gh run view',
      JSON.stringify({
        jobs: [
          {
            // databaseId omitted
            status: 'completed',
            conclusion: 'failure',
          },
        ],
      }),
    );

    const result = await ciFailedJobsGithub({ run_id: 5 });
    expectOk(result);
    expect(result.data.failed_jobs[0]).toEqual({
      job_id: 0,
      name: '',
      stage: null,
      conclusion: 'failure',
      started_at: null,
      finished_at: null,
      url: '',
    });
  });
});
