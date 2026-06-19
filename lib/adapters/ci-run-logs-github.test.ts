import { describe, test, expect, beforeEach } from 'bun:test';
import {
  installChildProcessMock,
  onExec,
  resetExecMock,
  execCalls,
} from '../test-support/mock-child-process.ts';
import type { AdapterResult, CiRunLogsResponse } from './types.ts';

// Subprocess-boundary tests for the GitHub ci_run_logs adapter (R-15).
// Integration-level coverage (handler dispatch, truncation composition,
// envelope shape) stays in tests/ci_run_logs.test.ts; this file owns the
// argv-shape and URL-construction assertions that prove the adapter speaks
// `gh` correctly.

interface ThrowableError extends Error {
  stderr?: string;
  stdout?: string;
  status?: number;
}

installChildProcessMock();

const { ciRunLogsGithub } = await import('./ci-run-logs-github.ts');

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

describe('ciRunLogsGithub — subprocess boundary', () => {
  test('argv: gh run view <id> --log-failed (default)', async () => {
    onExec('git remote get-url', 'https://github.com/org/repo.git\n');
    onExec('gh run view', 'some log\n');

    const result = await ciRunLogsGithub({ run_id: 12345, failed_only: true });
    expectOk(result);

    const call = findCall('gh run view');
    expect(call).toContain('12345');
    expect(call).toContain('--log-failed');
    expect(call).not.toContain(' --log ');
    expect(call).not.toMatch(/--log$/);
    // No --repo flag absent an explicit slug.
    expect(call).not.toContain('--repo');
    // No --job flag absent an explicit job_id.
    expect(call).not.toContain('--job');
  });

  test('argv: gh run view <id> --log when failed_only=false', async () => {
    onExec('git remote get-url', 'https://github.com/org/repo.git\n');
    onExec('gh run view', 'full log\n');

    await ciRunLogsGithub({ run_id: 1, failed_only: false });

    const call = findCall('gh run view');
    expect(call).toContain('--log');
    expect(call).not.toContain('--log-failed');
  });

  test('argv: --job <id> forwarded when job_id provided', async () => {
    onExec('git remote get-url', 'https://github.com/org/repo.git\n');
    onExec('gh run view', 'job-specific log\n');

    await ciRunLogsGithub({ run_id: 42, job_id: 999, failed_only: false });

    const call = findCall('gh run view');
    expect(call).toContain('--job');
    expect(call).toContain('999');
  });

  test('argv: --repo flag forwarded when repo provided', async () => {
    // No git remote probed when repo is explicit, but stub it anyway for safety.
    onExec('git remote get-url', 'https://github.com/cwd-org/cwd-repo.git\n');
    onExec('gh run view', 'cross-repo log\n');

    await ciRunLogsGithub({
      run_id: 77,
      failed_only: true,
      repo: 'other-org/other-repo',
    });

    const call = findCall('gh run view');
    expect(call).toContain('--repo');
    expect(call).toContain('other-org/other-repo');
  });

  test('returns AdapterResult with logs + url (implicit cwd slug)', async () => {
    onExec('git remote get-url', 'https://github.com/org/repo.git\n');
    onExec('gh run view', 'line1\nline2\n');

    const result = await ciRunLogsGithub({ run_id: 555, failed_only: true });
    expectOk(result);
    expect(result.data.logs).toBe('line1\nline2\n');
    expect(result.data.job_id).toBeNull();
    expect(result.data.url).toBe('https://github.com/org/repo/actions/runs/555');
  });

  test('returns AdapterResult with logs + url (explicit slug wins over cwd)', async () => {
    onExec('git remote get-url', 'https://github.com/cwd-org/cwd-repo.git\n');
    onExec('gh run view', 'xr log\n');

    const result = await ciRunLogsGithub({
      run_id: 888,
      failed_only: true,
      repo: 'other-org/other-repo',
    });
    expectOk(result);
    expect(result.data.url).toBe(
      'https://github.com/other-org/other-repo/actions/runs/888',
    );
    expect(result.data.url).not.toContain('cwd-org/cwd-repo');
  });

  test('response job_id mirrors caller job_id when provided', async () => {
    onExec('git remote get-url', 'https://github.com/org/repo.git\n');
    onExec('gh run view', 'j log\n');

    const result = await ciRunLogsGithub({
      run_id: 1,
      job_id: 321,
      failed_only: false,
    });
    expectOk(result);
    expect(result.data.job_id).toBe(321);
  });

  test('returns AdapterResult.error on gh failure (not thrown)', async () => {
    onExec('git remote get-url', 'https://github.com/org/repo.git\n');
    onExec('gh run view', () => {
      const err = new Error('gh: run not found') as ThrowableError;
      err.stderr = 'gh: run not found';
      err.status = 1;
      throw err;
    });

    const result = await ciRunLogsGithub({ run_id: 404, failed_only: true });
    expectErr(result);
    expect(result.code).toBe('gh_run_view_failed');
    expect(result.error).toContain('gh run view failed');
  });
});
