import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { AdapterResult, PrStatusResponse } from './types.ts';

// Subprocess-boundary tests for the GitHub pr_status adapter (R-15).
// Integration-level coverage (handler dispatch, error envelope) stays in
// tests/pr_status.test.ts; this file owns the argv-shape and response-parsing
// assertions that prove the adapter speaks `gh` correctly, plus the
// aggregateGithubChecks pass/fail/pending counting table.

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

const { prStatusGithub, aggregateGithubChecks } = await import('./pr-status-github.ts');

function on(match: string, respond: string | (() => string)): void {
  execRegistry.push({ match, respond });
}

function expectOk(
  r: AdapterResult<PrStatusResponse>,
): asserts r is { ok: true; data: PrStatusResponse } {
  if (!('ok' in r) || !r.ok) {
    throw new Error(`expected ok result, got ${JSON.stringify(r)}`);
  }
}

function expectErr(
  r: AdapterResult<PrStatusResponse>,
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

describe('prStatusGithub — subprocess boundary', () => {
  test('gh CLI invocation matches expected argv shape (happy path)', async () => {
    on(
      'gh pr view',
      JSON.stringify({
        state: 'OPEN',
        mergeStateStatus: 'CLEAN',
        mergeable: 'MERGEABLE',
        url: 'https://github.com/o/r/pull/42',
      }),
    );
    on(
      'gh pr checks',
      JSON.stringify([
        { name: 'validate', state: 'completed', conclusion: 'success' },
      ]),
    );

    const result = await prStatusGithub({ number: 42 });
    expectOk(result);
    expect(result.data.number).toBe(42);

    const viewCall = findCall('gh pr view');
    expect(viewCall).toContain('42');
    expect(viewCall).toContain('--json');
    // The handler-shape state/mergeStateStatus/mergeable/url JSON projection.
    expect(viewCall).toContain('state,mergeStateStatus,mergeable,url');
    expect(viewCall).not.toContain('--repo');

    const checksCall = findCall('gh pr checks');
    expect(checksCall).toContain('42');
    expect(checksCall).toContain('--json');
    expect(checksCall).toContain('name,state,conclusion');
    expect(checksCall).not.toContain('--repo');
  });

  test('parses pr view + pr checks responses into PrStatusResponse', async () => {
    on(
      'gh pr view',
      JSON.stringify({
        state: 'OPEN',
        mergeStateStatus: 'CLEAN',
        mergeable: 'MERGEABLE',
        url: 'https://github.com/o/r/pull/7',
      }),
    );
    on(
      'gh pr checks',
      JSON.stringify([
        { name: 'a', state: 'completed', conclusion: 'success' },
        { name: 'b', state: 'completed', conclusion: 'success' },
      ]),
    );

    const result = await prStatusGithub({ number: 7 });
    expectOk(result);
    expect(result.data).toEqual({
      number: 7,
      state: 'open',
      merge_state: 'clean',
      mergeable: true,
      checks: { total: 2, passed: 2, failed: 0, pending: 0, summary: 'all_passed' },
      url: 'https://github.com/o/r/pull/7',
    });
  });

  test('boolean mergeable=true is honored alongside MERGEABLE string', async () => {
    on(
      'gh pr view',
      JSON.stringify({
        state: 'OPEN',
        mergeStateStatus: 'CLEAN',
        mergeable: true,
        url: 'https://github.com/o/r/pull/3',
      }),
    );
    on('gh pr checks', JSON.stringify([]));

    const result = await prStatusGithub({ number: 3 });
    expectOk(result);
    expect(result.data.mergeable).toBe(true);
  });

  test('mergeStateStatus normalization covers UNSTABLE/DIRTY/BLOCKED/unknown', async () => {
    const cases: Array<[string, PrStatusResponse['merge_state']]> = [
      ['UNSTABLE', 'unstable'],
      ['DIRTY', 'dirty'],
      ['BLOCKED', 'blocked'],
      ['', 'unknown'],
      ['SOMETHING_NEW', 'unknown'],
    ];
    for (const [status, expected] of cases) {
      execRegistry = [];
      execCalls = [];
      on(
        'gh pr view',
        JSON.stringify({
          state: 'OPEN',
          mergeStateStatus: status,
          mergeable: 'UNKNOWN',
          url: 'https://github.com/o/r/pull/1',
        }),
      );
      on('gh pr checks', JSON.stringify([]));

      const result = await prStatusGithub({ number: 1 });
      expectOk(result);
      expect(result.data.merge_state).toBe(expected);
    }
  });

  test('state normalization MERGED/CLOSED/OPEN', async () => {
    const cases: Array<[string, PrStatusResponse['state']]> = [
      ['MERGED', 'merged'],
      ['CLOSED', 'closed'],
      ['OPEN', 'open'],
      ['weird', 'open'],
    ];
    for (const [raw, expected] of cases) {
      execRegistry = [];
      execCalls = [];
      on(
        'gh pr view',
        JSON.stringify({
          state: raw,
          mergeStateStatus: 'CLEAN',
          mergeable: 'UNKNOWN',
          url: 'https://github.com/o/r/pull/2',
        }),
      );
      on('gh pr checks', JSON.stringify([]));

      const result = await prStatusGithub({ number: 2 });
      expectOk(result);
      expect(result.data.state).toBe(expected);
    }
  });

  test('gh pr checks failure is treated as no checks (summary none)', async () => {
    on(
      'gh pr view',
      JSON.stringify({
        state: 'OPEN',
        mergeStateStatus: 'CLEAN',
        mergeable: 'MERGEABLE',
        url: 'https://github.com/o/r/pull/99',
      }),
    );
    on('gh pr checks', () => {
      const err = new Error('no checks reported') as ThrowableError;
      err.stderr = 'no checks reported';
      err.status = 1;
      throw err;
    });

    const result = await prStatusGithub({ number: 99 });
    expectOk(result);
    expect(result.data.checks.total).toBe(0);
    expect(result.data.checks.summary).toBe('none');
    // Mergeable etc. still flow from the pr view response.
    expect(result.data.merge_state).toBe('clean');
  });

  test('returns AdapterResult{ok:false, code} on gh pr view failure (not thrown)', async () => {
    on('gh pr view', () => {
      const err = new Error('gh: not found') as ThrowableError;
      err.stderr = 'gh: not found';
      err.status = 1;
      throw err;
    });

    const result = await prStatusGithub({ number: 404 });
    expectErr(result);
    expect(result.code).toBe('gh_pr_view_failed');
    expect(result.error).toContain('gh pr view failed');
  });

  test('--repo flag forwarded into both pr view AND pr checks', async () => {
    on(
      'gh pr view',
      JSON.stringify({
        state: 'OPEN',
        mergeStateStatus: 'CLEAN',
        mergeable: 'MERGEABLE',
        url: 'https://github.com/Org/Other/pull/5',
      }),
    );
    on('gh pr checks', JSON.stringify([]));

    await prStatusGithub({ number: 5, repo: 'Org/Other' });
    const viewCall = findCall('gh pr view');
    expect(viewCall).toContain('--repo');
    expect(viewCall).toContain('Org/Other');
    const checksCall = findCall('gh pr checks');
    expect(checksCall).toContain('--repo');
    expect(checksCall).toContain('Org/Other');
  });
});

describe('aggregateGithubChecks helper', () => {
  test('empty list → summary none, all counts zero', () => {
    expect(aggregateGithubChecks([])).toEqual({
      total: 0,
      passed: 0,
      failed: 0,
      pending: 0,
      summary: 'none',
    });
  });

  test('all success → summary all_passed', () => {
    const agg = aggregateGithubChecks([
      { name: 'a', state: 'completed', conclusion: 'success' },
      { name: 'b', state: 'completed', conclusion: 'success' },
    ]);
    expect(agg).toEqual({
      total: 2,
      passed: 2,
      failed: 0,
      pending: 0,
      summary: 'all_passed',
    });
  });

  test('any failure → summary has_failures (precedence over pending)', () => {
    const agg = aggregateGithubChecks([
      { name: 'a', state: 'completed', conclusion: 'success' },
      { name: 'b', state: 'completed', conclusion: 'failure' },
      { name: 'c', state: 'in_progress', conclusion: null },
    ]);
    expect(agg.summary).toBe('has_failures');
    expect(agg.passed).toBe(1);
    expect(agg.failed).toBe(1);
    expect(agg.pending).toBe(1);
  });

  test('failure synonyms count as failed (cancelled/timed_out/action_required)', () => {
    const agg = aggregateGithubChecks([
      { name: 'a', conclusion: 'cancelled' },
      { name: 'b', conclusion: 'timed_out' },
      { name: 'c', conclusion: 'action_required' },
      { name: 'd', state: 'failure' },
    ]);
    expect(agg.failed).toBe(4);
    expect(agg.summary).toBe('has_failures');
  });

  test('pending → summary pending when no failures', () => {
    const agg = aggregateGithubChecks([
      { name: 'a', state: 'completed', conclusion: 'success' },
      { name: 'b', state: 'in_progress', conclusion: null },
    ]);
    expect(agg.summary).toBe('pending');
    expect(agg.passed).toBe(1);
    expect(agg.pending).toBe(1);
    expect(agg.failed).toBe(0);
  });

  test('null/missing conclusion treated as pending', () => {
    const agg = aggregateGithubChecks([
      { name: 'a', state: 'queued' },
      { name: 'b', conclusion: null },
    ]);
    expect(agg.pending).toBe(2);
    expect(agg.summary).toBe('pending');
  });
});
