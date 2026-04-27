import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { AdapterResult, CiListRunsResponse } from './types.ts';

// Subprocess-boundary tests for the GitHub ciListRuns adapter (R-15).
// Integration-level coverage (handler envelope + polling phases) stays in
// tests/ci_wait_run.test.ts; this file owns the argv-shape + normalization
// assertions that prove the adapter speaks `gh run list` correctly.

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

const { ciListRunsGithub } = await import('./ci-list-runs-github.ts');

function on(match: string, respond: string | (() => string)): void {
  execRegistry.push({ match, respond });
}

function expectOk(
  r: AdapterResult<CiListRunsResponse>,
): asserts r is { ok: true; data: CiListRunsResponse } {
  if (!('ok' in r) || !r.ok) {
    throw new Error(`expected ok result, got ${JSON.stringify(r)}`);
  }
}

function expectErr(
  r: AdapterResult<CiListRunsResponse>,
): asserts r is { ok: false; error: string; code: string } {
  if (!('ok' in r) || r.ok) {
    throw new Error(`expected error result, got ${JSON.stringify(r)}`);
  }
}

function findCall(needle: string): string {
  return execCalls.find((c) => c.includes(needle) || unquote(c).includes(needle)) ?? '';
}

function ghRun(overrides: Record<string, unknown> = {}) {
  return {
    databaseId: 12345,
    name: 'CI',
    workflowName: 'CI',
    status: 'in_progress',
    conclusion: null,
    url: 'https://github.com/org/repo/actions/runs/12345',
    headSha: '1234567890abcdef1234567890abcdef12345678',
    headBranch: 'feature/1-demo',
    createdAt: '2026-04-07T12:00:00Z',
    event: 'push',
    ...overrides,
  };
}

beforeEach(() => {
  execRegistry = [];
  execCalls = [];
});

describe('ciListRunsGithub — subprocess boundary', () => {
  test('argv: --branch for non-SHA ref; normalizes single run with event', async () => {
    on('gh run list', JSON.stringify([ghRun({ event: 'push' })]));

    const result = await ciListRunsGithub({ ref: 'feature/1-demo', limit: 20 });
    expectOk(result);
    expect(result.data.length).toBe(1);
    const run = result.data[0];
    expect(run.run_id).toBe(12345);
    expect(run.workflow_name).toBe('CI');
    expect(run.status).toBe('in_progress');
    expect(run.conclusion).toBeNull();
    expect(run.head_sha).toBe('1234567890abcdef1234567890abcdef12345678');
    expect(run.head_branch).toBe('feature/1-demo');
    expect(run.event).toBe('push');

    const call = findCall('gh run list');
    expect(call).toContain('--branch');
    expect(call).toContain('feature/1-demo');
    expect(call).not.toContain('--commit');
    expect(call).toContain('--limit');
    expect(call).toContain('20');
    expect(call).toContain('event');
  });

  test('argv: --commit for 40-char hex SHA ref', async () => {
    const sha = 'a'.repeat(40);
    on('gh run list', JSON.stringify([ghRun({ headSha: sha })]));

    await ciListRunsGithub({ ref: sha, limit: 5 });
    const call = findCall('gh run list');
    expect(call).toContain('--commit');
    expect(call).toContain(sha);
    expect(call).not.toContain('--branch');
  });

  test('argv: expected_sha with branch ref passes BOTH --branch and --commit', async () => {
    const sha = 'b'.repeat(40);
    on('gh run list', JSON.stringify([ghRun({ headSha: sha })]));

    await ciListRunsGithub({ ref: 'main', expected_sha: sha, limit: 20 });
    const call = findCall('gh run list');
    expect(call).toContain('--branch');
    expect(call).toContain('main');
    expect(call).toContain('--commit');
    expect(call).toContain(sha);
  });

  test('argv: expected_sha with SHA ref passes ONLY --commit (no --branch)', async () => {
    const sha = 'c'.repeat(40);
    on('gh run list', JSON.stringify([ghRun({ headSha: sha })]));

    await ciListRunsGithub({ ref: sha, expected_sha: sha, limit: 20 });
    const call = findCall('gh run list');
    expect(call).toContain('--commit');
    expect(call).not.toContain('--branch');
  });

  test('argv: --workflow and --repo forwarded', async () => {
    on('gh run list', JSON.stringify([]));

    await ciListRunsGithub({
      ref: 'main',
      workflow_name: 'Deploy',
      repo: 'other-org/other-repo',
      limit: 20,
    });
    const call = findCall('gh run list');
    expect(call).toContain('--workflow');
    expect(call).toContain('Deploy');
    expect(call).toContain('--repo');
    expect(call).toContain('other-org/other-repo');
  });

  test('empty array returns ok with empty data', async () => {
    on('gh run list', JSON.stringify([]));

    const result = await ciListRunsGithub({ ref: 'main', limit: 20 });
    expectOk(result);
    expect(result.data).toEqual([]);
  });

  test('empty stdout returns ok with empty data', async () => {
    on('gh run list', '');

    const result = await ciListRunsGithub({ ref: 'main', limit: 20 });
    expectOk(result);
    expect(result.data).toEqual([]);
  });

  test('normalizes merge_group event (feeds the pre-flight detector)', async () => {
    on(
      'gh run list',
      JSON.stringify([ghRun({ event: 'merge_group', databaseId: 777 })]),
    );

    const result = await ciListRunsGithub({ ref: 'main', limit: 20 });
    expectOk(result);
    expect(result.data[0].event).toBe('merge_group');
    expect(result.data[0].run_id).toBe(777);
  });

  test('workflowName preferred over name for workflow_name field', async () => {
    on(
      'gh run list',
      JSON.stringify([ghRun({ name: 'fallback', workflowName: 'Real CI' })]),
    );

    const result = await ciListRunsGithub({ ref: 'main', limit: 20 });
    expectOk(result);
    expect(result.data[0].workflow_name).toBe('Real CI');
  });

  test('returns AdapterResult.error on gh failure (not thrown)', async () => {
    on('gh run list', () => {
      const err = new Error('gh: not authenticated') as ThrowableError;
      err.stderr = 'gh: not authenticated';
      err.status = 1;
      throw err;
    });

    const result = await ciListRunsGithub({ ref: 'main', limit: 20 });
    expectErr(result);
    expect(result.code).toBe('gh_run_list_failed');
    expect(result.error).toContain('gh run list failed');
  });
});
