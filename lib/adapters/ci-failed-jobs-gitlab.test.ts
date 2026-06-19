import { describe, test, expect, beforeEach } from 'bun:test';
import {
  installChildProcessMock,
  onExec,
  resetExecMock,
  execCalls,
} from '../test-support/mock-child-process.ts';
import type { AdapterResult, CiFailedJobsResponse } from './types.ts';

// Subprocess-boundary tests for the GitLab ci_failed_jobs adapter (R-15).
// Integration-level coverage stays in tests/ci_failed_jobs.test.ts; this file
// covers argv-shape, REST-payload parsing, the status filter (failed vs.
// canceled/skipped/pending), and the encoded-slug vs. `:id` dispatch.

interface ThrowableError extends Error {
  stderr?: string;
  stdout?: string;
  status?: number;
}

installChildProcessMock();

const { ciFailedJobsGitlab } = await import('./ci-failed-jobs-gitlab.ts');

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
  const unquote = (cmd: string) => cmd.replace(/'([^']*)'/g, '$1');
  return execCalls().find((c) => c.includes(needle) || unquote(c).includes(needle)) ?? '';
}

beforeEach(() => {
  resetExecMock();
});

describe('ciFailedJobsGitlab — subprocess boundary', () => {
  test('argv: glab api projects/:id/pipelines/<id>/jobs (no repo)', async () => {
    onExec('glab api projects/:id/pipelines/42/jobs', JSON.stringify([]));

    const result = await ciFailedJobsGitlab({ run_id: 42 });
    expectOk(result);

    const call = findCall('glab api');
    expect(call).toContain('projects/:id/pipelines/42/jobs');
  });

  test('argv: explicit repo URL-encoded into path', async () => {
    onExec(
      'glab api projects/other-org%2Fother-repo/pipelines/101/jobs',
      JSON.stringify([]),
    );

    const result = await ciFailedJobsGitlab({
      run_id: 101,
      repo: 'other-org/other-repo',
    });
    expectOk(result);

    const call = findCall('glab api');
    expect(call).toContain('projects/other-org%2Fother-repo/pipelines/101/jobs');
    expect(call).not.toContain('projects/:id/');
  });

  test('normalizes failed jobs — mixed statuses, stage populated', async () => {
    onExec(
      'glab api projects/:id/pipelines/42/jobs',
      JSON.stringify([
        {
          id: 201,
          name: 'lint',
          status: 'success',
          stage: 'test',
          started_at: '2025-02-01T00:00:00Z',
          finished_at: '2025-02-01T00:01:00Z',
          web_url: 'https://gitlab.com/o/r/-/jobs/201',
        },
        {
          id: 202,
          name: 'unit-test',
          status: 'failed',
          stage: 'test',
          started_at: '2025-02-01T00:00:00Z',
          finished_at: '2025-02-01T00:03:00Z',
          web_url: 'https://gitlab.com/o/r/-/jobs/202',
        },
        {
          id: 203,
          name: 'deploy',
          status: 'failed',
          stage: 'deploy',
          started_at: '2025-02-01T00:04:00Z',
          finished_at: '2025-02-01T00:05:00Z',
          web_url: 'https://gitlab.com/o/r/-/jobs/203',
        },
      ]),
    );

    const result = await ciFailedJobsGitlab({ run_id: 42 });
    expectOk(result);
    expect(result.data.failed_jobs).toHaveLength(2);
    expect(result.data.failed_jobs[0]).toEqual({
      job_id: 202,
      name: 'unit-test',
      stage: 'test',
      conclusion: 'failure',
      started_at: '2025-02-01T00:00:00Z',
      finished_at: '2025-02-01T00:03:00Z',
      url: 'https://gitlab.com/o/r/-/jobs/202',
    });
    expect(result.data.failed_jobs[1].stage).toBe('deploy');
  });

  test('skips canceled/skipped/pending jobs (only "failed" passes)', async () => {
    onExec(
      'glab api projects/:id/pipelines/66/jobs',
      JSON.stringify([
        { id: 1, name: 'cancelled-job', status: 'canceled', stage: 'test' },
        { id: 2, name: 'pending-job', status: 'pending', stage: 'test' },
        { id: 3, name: 'skipped-job', status: 'skipped', stage: 'test' },
        {
          id: 4,
          name: 'real-failure',
          status: 'failed',
          stage: 'test',
          started_at: null,
          finished_at: null,
          web_url: 'https://gitlab.com/o/r/-/jobs/4',
        },
      ]),
    );

    const result = await ciFailedJobsGitlab({ run_id: 66 });
    expectOk(result);
    expect(result.data.failed_jobs).toHaveLength(1);
    expect(result.data.failed_jobs[0].name).toBe('real-failure');
    expect(result.data.failed_jobs[0].started_at).toBeNull();
    expect(result.data.failed_jobs[0].finished_at).toBeNull();
  });

  test('all success returns empty list', async () => {
    onExec(
      'glab api projects/:id/pipelines/1/jobs',
      JSON.stringify([
        { id: 1, name: 'lint', status: 'success', stage: 'test' },
      ]),
    );

    const result = await ciFailedJobsGitlab({ run_id: 1 });
    expectOk(result);
    expect(result.data.failed_jobs).toEqual([]);
  });

  test('returns AdapterResult.error on glab failure (not thrown)', async () => {
    onExec('glab api', () => {
      const err = new Error('glab: not authenticated') as ThrowableError;
      err.stderr = 'glab: not authenticated';
      err.status = 1;
      throw err;
    });

    const result = await ciFailedJobsGitlab({ run_id: 77 });
    expectErr(result);
    expect(result.code).toBe('glab_api_jobs_failed');
    expect(result.error).toContain('glab api failed');
  });

  test('missing fields coerce to safe defaults', async () => {
    onExec(
      'glab api projects/:id/pipelines/9/jobs',
      JSON.stringify([{ status: 'failed' }]),
    );

    const result = await ciFailedJobsGitlab({ run_id: 9 });
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
