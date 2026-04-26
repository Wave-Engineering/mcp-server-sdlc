import { describe, test, expect, mock, beforeEach } from 'bun:test';

// Subprocess-boundary tests for the GitHub pr_wait_ci adapter (R-15).
// Integration-level coverage (handler dispatch, polling-loop behavior across
// multiple iterations) stays in tests/pr_wait_ci.test.ts. This file owns the
// argv-shape assertions that lock the gh<2.50 compat path (#220), the
// `classifyRollupItem` mapping table (14 cases), and the all-skipped
// regression (#221) end-to-end via the snapshot function.

interface ThrowableError extends Error {
  stderr?: string;
  stdout?: string;
  status?: number;
}

let execRegistry: Array<{ match: string; respond: string | (() => string) }> = [];
let execCalls: string[] = [];

const mockExecSync = mock((cmd: string, _opts?: unknown) => {
  execCalls.push(cmd);
  for (const { match, respond } of execRegistry) {
    if (cmd.includes(match)) {
      return typeof respond === 'function' ? respond() : respond;
    }
  }
  const err = new Error(`Unexpected exec: ${cmd}`) as ThrowableError;
  err.stderr = `Unexpected exec: ${cmd}`;
  err.status = 127;
  throw err;
});

mock.module('child_process', () => ({ execSync: mockExecSync }));

const {
  prWaitCiGithub,
  classifyRollupItem,
  snapshotGithub,
} = await import('./pr-wait-ci-github.ts');

function on(match: string, respond: string | (() => string)): void {
  execRegistry.push({ match, respond });
}

beforeEach(() => {
  execRegistry = [];
  execCalls = [];
});

describe('snapshotGithub — argv shape (#220 regression)', () => {
  test('uses `gh pr view --json statusCheckRollup,url` (NOT `gh pr checks --json`)', () => {
    on(
      'gh pr view',
      JSON.stringify({
        url: 'https://github.com/org/repo/pull/5',
        statusCheckRollup: [
          { __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' },
        ],
      }),
    );

    const snap = snapshotGithub(5);
    expect(snap.total).toBe(1);
    expect(snap.passed).toBe(1);

    const viewCall = execCalls.find((c) => c.startsWith('gh pr view')) ?? '';
    expect(viewCall).toContain('gh pr view 5');
    expect(viewCall).toContain('--json');
    expect(viewCall).toContain('statusCheckRollup');
    expect(viewCall).toContain('url');
    // Regression guard for #220 — `gh pr checks --json` was added in a later
    // gh release and broke the handler on Ubuntu 24.04's default gh 2.45.
    expect(execCalls.some((c) => c.startsWith('gh pr checks'))).toBe(false);
  });

  test('threads --repo flag when provided', () => {
    on(
      'gh pr view',
      JSON.stringify({
        url: 'https://github.com/Wave-Engineering/mcp-server-sdlc/pull/42',
        statusCheckRollup: [
          { __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' },
        ],
      }),
    );

    snapshotGithub(42, 'Wave-Engineering/mcp-server-sdlc');
    const viewCall = execCalls.find((c) => c.startsWith('gh pr view')) ?? '';
    expect(viewCall).toContain('--repo Wave-Engineering/mcp-server-sdlc');
  });

  test('omits --repo when undefined', () => {
    on(
      'gh pr view',
      JSON.stringify({
        url: 'https://github.com/org/repo/pull/9',
        statusCheckRollup: [
          { __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' },
        ],
      }),
    );
    snapshotGithub(9);
    const viewCall = execCalls.find((c) => c.startsWith('gh pr view')) ?? '';
    expect(viewCall).not.toContain('--repo');
  });

  test('counts mixed CheckRun + StatusContext + SKIPPED correctly', () => {
    on(
      'gh pr view',
      JSON.stringify({
        url: 'https://github.com/org/repo/pull/77',
        statusCheckRollup: [
          { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
          { __typename: 'CheckRun', name: 'optional', status: 'COMPLETED', conclusion: 'SKIPPED' },
          { __typename: 'StatusContext', context: 'codecov/patch', state: 'SUCCESS' },
          { __typename: 'StatusContext', context: 'license/cla', state: 'PENDING' },
          { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' },
        ],
      }),
    );

    const snap = snapshotGithub(77);
    expect(snap.total).toBe(5); // includes the SKIPPED entry
    expect(snap.passed).toBe(2); // build + codecov
    expect(snap.failed).toBe(1); // lint
    expect(snap.pending).toBe(1); // license/cla
  });

  test('throws on gh failure (handler/poll-loop layer maps to AdapterResult)', () => {
    execRegistry = [];
    on('gh pr view', () => {
      const err = new Error('HTTP 404: Not Found') as ThrowableError;
      err.stderr = 'HTTP 404: Not Found';
      err.status = 1;
      throw err;
    });
    expect(() => snapshotGithub(9999)).toThrow();
  });

  test('omits url when missing in response', () => {
    on(
      'gh pr view',
      JSON.stringify({ statusCheckRollup: [] }),
    );
    const snap = snapshotGithub(1);
    expect(snap.url).toBe('');
    expect(snap.total).toBe(0);
  });
});

// classifyRollupItem table — every branch documented in the JSDoc. Pure-function
// tests so the mapping can be exercised without a subprocess. (Mirrors the 14
// cases preserved from #220/#221 in tests/pr_wait_ci.test.ts.)
describe('classifyRollupItem — full mapping table', () => {
  test('CheckRun COMPLETED+SUCCESS → pass', () => {
    expect(classifyRollupItem({ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' })).toBe('pass');
  });

  test('CheckRun COMPLETED+NEUTRAL → pass', () => {
    expect(classifyRollupItem({ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'NEUTRAL' })).toBe('pass');
  });

  test('CheckRun COMPLETED+FAILURE → fail', () => {
    expect(classifyRollupItem({ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' })).toBe('fail');
  });

  test('CheckRun COMPLETED+CANCELLED → fail', () => {
    expect(classifyRollupItem({ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'CANCELLED' })).toBe('fail');
  });

  test('CheckRun COMPLETED+TIMED_OUT → fail', () => {
    expect(classifyRollupItem({ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'TIMED_OUT' })).toBe('fail');
  });

  test('CheckRun COMPLETED+STARTUP_FAILURE → fail', () => {
    expect(classifyRollupItem({ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'STARTUP_FAILURE' })).toBe('fail');
  });

  test('CheckRun COMPLETED+ACTION_REQUIRED → fail (needs human, not patience)', () => {
    expect(classifyRollupItem({ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'ACTION_REQUIRED' })).toBe('fail');
  });

  test('CheckRun IN_PROGRESS → pending', () => {
    expect(classifyRollupItem({ __typename: 'CheckRun', status: 'IN_PROGRESS' })).toBe('pending');
  });

  test('CheckRun QUEUED → pending', () => {
    expect(classifyRollupItem({ __typename: 'CheckRun', status: 'QUEUED' })).toBe('pending');
  });

  test('CheckRun COMPLETED+SKIPPED → skipping (uncounted)', () => {
    expect(classifyRollupItem({ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SKIPPED' })).toBe('skipping');
  });

  test('CheckRun COMPLETED+STALE → skipping (uncounted)', () => {
    expect(classifyRollupItem({ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'STALE' })).toBe('skipping');
  });

  test('StatusContext SUCCESS → pass', () => {
    expect(classifyRollupItem({ __typename: 'StatusContext', state: 'SUCCESS' })).toBe('pass');
  });

  test('StatusContext PENDING → pending', () => {
    expect(classifyRollupItem({ __typename: 'StatusContext', state: 'PENDING' })).toBe('pending');
  });

  test('StatusContext FAILURE → fail', () => {
    expect(classifyRollupItem({ __typename: 'StatusContext', state: 'FAILURE' })).toBe('fail');
  });

  test('StatusContext ERROR → fail', () => {
    expect(classifyRollupItem({ __typename: 'StatusContext', state: 'ERROR' })).toBe('fail');
  });

  test('unknown __typename → pending (defensive default)', () => {
    expect(classifyRollupItem({ __typename: 'FutureCheckType', status: 'COMPLETED', conclusion: 'SUCCESS' })).toBe('pending');
    expect(classifyRollupItem({})).toBe('pending');
  });
});

// All-skipped does NOT deadlock — #221 regression. Drives the full
// prWaitCiGithub path through the polling loop with a tight timeout/interval
// so a single snapshot iteration suffices.
describe('prWaitCiGithub — #221 all-skipped regression', () => {
  test('all SKIPPED checks → final_state passed on first poll', async () => {
    on(
      'gh pr view',
      JSON.stringify({
        url: 'https://github.com/org/repo/pull/1',
        statusCheckRollup: [
          { __typename: 'CheckRun', name: 'a', status: 'COMPLETED', conclusion: 'SKIPPED' },
          { __typename: 'CheckRun', name: 'b', status: 'COMPLETED', conclusion: 'SKIPPED' },
          { __typename: 'CheckRun', name: 'c', status: 'COMPLETED', conclusion: 'SKIPPED' },
        ],
      }),
    );

    const result = await prWaitCiGithub({
      number: 1,
      poll_interval_sec: 5,
      timeout_sec: 10,
    });

    if (!('ok' in result) || !result.ok) {
      throw new Error(`expected ok result, got ${JSON.stringify(result)}`);
    }
    expect(result.data.final_state).toBe('passed');
    expect(result.data.checks.passed).toBe(0);
    expect(result.data.checks.total).toBe(3); // total counts SKIPPED
    expect(result.data.checks.failed).toBe(0);
    expect(result.data.checks.pending).toBe(0);
  });
});

describe('prWaitCiGithub — failure surfaces as AdapterResult', () => {
  test('gh failure → ok:false, code unexpected_error', async () => {
    on('gh pr view', () => {
      const err = new Error('HTTP 404: Not Found') as ThrowableError;
      err.stderr = 'HTTP 404: Not Found';
      err.status = 1;
      throw err;
    });

    const result = await prWaitCiGithub({
      number: 9999,
      poll_interval_sec: 5,
      timeout_sec: 10,
    });
    if (!('ok' in result) || result.ok) {
      throw new Error(`expected error result, got ${JSON.stringify(result)}`);
    }
    expect(result.code).toBe('unexpected_error');
    expect(result.error).toContain('HTTP 404');
  });
});
