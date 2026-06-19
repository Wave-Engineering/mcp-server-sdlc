import { describe, test, expect, beforeEach } from 'bun:test';
import {
  installChildProcessMock,
  onExec,
  resetExecMock,
  execCalls,
} from '../test-support/mock-child-process.ts';
import type { AdapterResult, CiRunLogsResponse } from './types.ts';

// Subprocess-boundary tests for the GitLab ci_run_logs adapter (R-15).
// Integration-level coverage stays in tests/ci_run_logs.test.ts; this file
// covers argv-shape, the two-step flow (resolve failed job → trace), and
// the encoded-slug vs. `:id` dispatch.

interface ThrowableError extends Error {
  stderr?: string;
  stdout?: string;
  status?: number;
}

installChildProcessMock();

const { ciRunLogsGitlab } = await import('./ci-run-logs-gitlab.ts');

function expectOk(
  r: AdapterResult<CiRunLogsResponse>,
): asserts r is { ok: true; data: CiRunLogsResponse } {
  if (!('ok' in r) || !r.ok) {
    throw new Error(`expected ok result, got ${JSON.stringify(r)}`);
  }
}

function expectErr(
  r: AdapterResult<CiRunLogsResponse>,
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

// Fixture convention: use the house-standard `org/repo` slug for the cwd
// remote (matches all sibling adapter tests). Do NOT diverge to a unique slug
// here — `parseRepoSlug()` resolves `execSync` from `child_process`, which every
// test file mocks via Bun's process-global `mock.module`. At full-suite scale on
// the CI runner's file-discovery order, that shared binding can resolve to a
// *different* file's mock registry, so a slug that diverges from the universal
// `org/repo` is the only one that mismatches and flakes the release (#445).
// Slug-PARSING correctness is owned by lib/shared/parse-repo-slug.test.ts; these
// boundary tests only verify the cwd fallback fires and the URL is composed.
describe('ciRunLogsGitlab — subprocess boundary', () => {
  test('argv: glab ci trace <job_id> when caller supplies job_id (no resolution)', async () => {
    onExec('git remote get-url', 'https://gitlab.com/org/repo.git\n');
    onExec('glab ci trace 77', 'trace content\n');

    const result = await ciRunLogsGitlab({
      run_id: 10,
      job_id: 77,
      failed_only: true,
    });
    expectOk(result);

    // Should NOT probe the pipelines API — caller specified the job.
    const apiCall = findCall('glab api');
    expect(apiCall).toBe('');

    const traceCall = findCall('glab ci trace');
    expect(traceCall).toContain('77');
  });

  test('resolves failed job then fetches trace (two-step flow)', async () => {
    onExec('git remote get-url', 'https://gitlab.com/org/repo.git\n');
    onExec(
      'glab api projects/:id/pipelines/55/jobs',
      JSON.stringify([
        { id: 100, status: 'success' },
        { id: 101, status: 'failed' },
        { id: 102, status: 'failed' },
      ]),
    );
    onExec('glab ci trace 101', 'failed job log\n');

    const result = await ciRunLogsGitlab({ run_id: 55, failed_only: true });
    expectOk(result);
    expect(result.data.job_id).toBe(101);
    expect(result.data.logs).toBe('failed job log\n');

    // Confirm both subprocess steps ran.
    expect(findCall('glab api')).toContain('projects/:id/pipelines/55/jobs');
    expect(findCall('glab ci trace')).toContain('101');
  });

  test('argv: explicit repo URL-encoded in pipelines path', async () => {
    onExec(
      'glab api projects/other-org%2Fother-repo/pipelines/99/jobs',
      JSON.stringify([{ id: 701, status: 'failed' }]),
    );
    onExec('glab ci trace 701', 'xr trace\n');

    const result = await ciRunLogsGitlab({
      run_id: 99,
      failed_only: true,
      repo: 'other-org/other-repo',
    });
    expectOk(result);

    const apiCall = findCall('glab api');
    expect(apiCall).toContain('projects/other-org%2Fother-repo/pipelines/99/jobs');
    expect(apiCall).not.toContain('projects/:id');
  });

  test('argv: -R <slug> forwarded to glab ci trace when repo provided', async () => {
    onExec(
      'glab api projects/other-org%2Fother-repo/pipelines/12/jobs',
      JSON.stringify([{ id: 7, status: 'failed' }]),
    );
    onExec('glab ci trace 7', 'log\n');

    await ciRunLogsGitlab({
      run_id: 12,
      failed_only: true,
      repo: 'other-org/other-repo',
    });

    const trace = findCall('glab ci trace');
    expect(trace).toContain('-R');
    expect(trace).toContain('other-org/other-repo');
  });

  test('returns AdapterResult with url built from explicit slug', async () => {
    onExec(
      'glab api projects/other-org%2Fother-repo/pipelines/12/jobs',
      JSON.stringify([{ id: 7, status: 'failed' }]),
    );
    onExec('glab ci trace 7', 'log\n');

    const result = await ciRunLogsGitlab({
      run_id: 12,
      failed_only: true,
      repo: 'other-org/other-repo',
    });
    expectOk(result);
    expect(result.data.url).toBe('https://gitlab.com/other-org/other-repo/-/jobs/7');
  });

  test('returns AdapterResult with url built from cwd slug when repo omitted', async () => {
    onExec('git remote get-url', 'https://gitlab.com/org/repo.git\n');
    onExec('glab ci trace 77', 'log\n');

    const result = await ciRunLogsGitlab({
      run_id: 10,
      job_id: 77,
      failed_only: true,
    });
    expectOk(result);
    expect(result.data.url).toBe('https://gitlab.com/org/repo/-/jobs/77');
  });

  test('returns AdapterResult.error when no failed job in pipeline', async () => {
    onExec('git remote get-url', 'https://gitlab.com/org/repo.git\n');
    onExec(
      'glab api projects/:id/pipelines/99/jobs',
      JSON.stringify([{ id: 1, status: 'success' }]),
    );

    const result = await ciRunLogsGitlab({ run_id: 99, failed_only: true });
    expectErr(result);
    expect(result.code).toBe('no_failed_job');
    expect(result.error).toContain('no failed job');
  });

  test('returns AdapterResult.error when glab api fails', async () => {
    onExec('git remote get-url', 'https://gitlab.com/org/repo.git\n');
    onExec('glab api', () => {
      const err = new Error('glab: not authenticated') as ThrowableError;
      err.stderr = 'glab: not authenticated';
      err.status = 1;
      throw err;
    });

    const result = await ciRunLogsGitlab({ run_id: 7, failed_only: true });
    expectErr(result);
    expect(result.code).toBe('glab_api_jobs_failed');
    expect(result.error).toContain('glab api failed');
  });

  test('returns AdapterResult.error when glab ci trace fails', async () => {
    onExec('git remote get-url', 'https://gitlab.com/org/repo.git\n');
    onExec('glab ci trace', () => {
      const err = new Error('glab: job not found') as ThrowableError;
      err.stderr = 'glab: job not found';
      err.status = 1;
      throw err;
    });

    const result = await ciRunLogsGitlab({
      run_id: 10,
      job_id: 77,
      failed_only: true,
    });
    expectErr(result);
    expect(result.code).toBe('glab_ci_trace_failed');
    expect(result.error).toContain('glab ci trace failed');
  });
});
