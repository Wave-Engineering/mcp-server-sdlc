import { describe, test, expect, beforeEach } from 'bun:test';
import {
  installChildProcessMock,
  onExec,
  resetExecMock,
  execCalls,
} from '../test-support/mock-child-process.ts';

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

installChildProcessMock();

const {
  prWaitCiGithub,
  classifyRollupItem,
  snapshotGithub,
  emptyRollupBlocker,
  probeGithub,
} = await import('./pr-wait-ci-github.ts');

beforeEach(() => {
  resetExecMock();
});

describe('snapshotGithub — argv shape (#220 regression)', () => {
  test('uses `gh pr view --json statusCheckRollup,url` (NOT `gh pr checks --json`)', () => {
    onExec(
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

    const viewCall = execCalls().find((c) => c.startsWith('gh pr view')) ?? '';
    expect(viewCall).toContain('gh pr view 5');
    expect(viewCall).toContain('--json');
    expect(viewCall).toContain('statusCheckRollup');
    expect(viewCall).toContain('url');
    // Regression guard for #220 — `gh pr checks --json` was added in a later
    // gh release and broke the handler on Ubuntu 24.04's default gh 2.45.
    expect(execCalls().some((c) => c.startsWith('gh pr checks'))).toBe(false);
  });

  test('threads --repo flag when provided', () => {
    onExec(
      'gh pr view',
      JSON.stringify({
        url: 'https://github.com/Wave-Engineering/mcp-server-sdlc/pull/42',
        statusCheckRollup: [
          { __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' },
        ],
      }),
    );

    snapshotGithub(42, 'Wave-Engineering/mcp-server-sdlc');
    const viewCall = execCalls().find((c) => c.startsWith('gh pr view')) ?? '';
    expect(viewCall).toContain('--repo Wave-Engineering/mcp-server-sdlc');
  });

  test('omits --repo when undefined', () => {
    onExec(
      'gh pr view',
      JSON.stringify({
        url: 'https://github.com/org/repo/pull/9',
        statusCheckRollup: [
          { __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' },
        ],
      }),
    );
    snapshotGithub(9);
    const viewCall = execCalls().find((c) => c.startsWith('gh pr view')) ?? '';
    expect(viewCall).not.toContain('--repo');
  });

  test('counts mixed CheckRun + StatusContext + SKIPPED correctly', () => {
    onExec(
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
    resetExecMock();
    onExec('gh pr view', () => {
      const err = new Error('HTTP 404: Not Found') as ThrowableError;
      err.stderr = 'HTTP 404: Not Found';
      err.status = 1;
      throw err;
    });
    expect(() => snapshotGithub(9999)).toThrow();
  });

  test('omits url when missing in response', () => {
    onExec(
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
    onExec(
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
    if (!('final_state' in result.data)) {
      throw new Error(`expected polled-response shape, got ${JSON.stringify(result.data)}`);
    }
    expect(result.data.final_state).toBe('passed');
    expect(result.data.checks.passed).toBe(0);
    expect(result.data.checks.total).toBe(3); // total counts SKIPPED
    expect(result.data.checks.failed).toBe(0);
    expect(result.data.checks.pending).toBe(0);
  });
});

// --- #416: empty-rollup short-circuit at the adapter boundary -----------
describe('prWaitCiGithub — empty-rollup short-circuit (#416)', () => {
  test('empty rollup + mergeable → no_checks_required immediately', async () => {
    onExec(
      'gh pr view',
      JSON.stringify({
        url: 'https://github.com/org/repo/pull/42',
        statusCheckRollup: [],
        state: 'OPEN',
        isDraft: false,
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
      }),
    );

    const result = await prWaitCiGithub({
      number: 42,
      poll_interval_sec: 5,
      timeout_sec: 1800, // huge — proves we don't enter the poll loop
    });
    if (!('ok' in result) || !result.ok) {
      throw new Error(`expected ok result, got ${JSON.stringify(result)}`);
    }
    const data = result.data as { status?: string; mergeable?: boolean; blocker?: string; elapsed_sec?: number; url?: string };
    expect(data.status).toBe('no_checks_required');
    expect(data.mergeable).toBe(true);
    expect(data.blocker).toBeUndefined();
    expect(data.elapsed_sec).toBeLessThan(5);
    expect(data.url).toBe('https://github.com/org/repo/pull/42');
    // Probe argv must include the new fields the short-circuit needs.
    const viewCall = execCalls().find((c) => c.startsWith('gh pr view')) ?? '';
    expect(viewCall).toContain('mergeable');
    expect(viewCall).toContain('isDraft');
    expect(viewCall).toContain('state');
    // #220 regression — never use the broken `gh pr checks --json` form.
    expect(execCalls().some((c) => c.startsWith('gh pr checks'))).toBe(false);
  });

  test('empty rollup + CONFLICTING → no_checks_required + conflicts blocker', async () => {
    onExec(
      'gh pr view',
      JSON.stringify({
        url: 'https://github.com/org/repo/pull/43',
        statusCheckRollup: [],
        state: 'OPEN',
        isDraft: false,
        mergeable: 'CONFLICTING',
        mergeStateStatus: 'DIRTY',
      }),
    );
    const result = await prWaitCiGithub({
      number: 43,
      poll_interval_sec: 5,
      timeout_sec: 1800,
    });
    if (!('ok' in result) || !result.ok) throw new Error('expected ok');
    const data = result.data as { status?: string; mergeable?: boolean; blocker?: string };
    expect(data.status).toBe('no_checks_required');
    expect(data.mergeable).toBe(false);
    expect(data.blocker).toBe('conflicts');
  });

  test('empty rollup + draft → no_checks_required + draft blocker', async () => {
    onExec(
      'gh pr view',
      JSON.stringify({
        url: 'https://github.com/org/repo/pull/44',
        statusCheckRollup: [],
        state: 'OPEN',
        isDraft: true,
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
      }),
    );
    const result = await prWaitCiGithub({ number: 44, poll_interval_sec: 5, timeout_sec: 60 });
    if (!('ok' in result) || !result.ok) throw new Error('expected ok');
    const data = result.data as { status?: string; mergeable?: boolean; blocker?: string };
    expect(data.status).toBe('no_checks_required');
    expect(data.mergeable).toBe(false);
    expect(data.blocker).toBe('draft');
  });

  test('empty rollup + closed PR → no_checks_required + closed blocker', async () => {
    onExec(
      'gh pr view',
      JSON.stringify({
        url: 'https://github.com/org/repo/pull/45',
        statusCheckRollup: [],
        state: 'CLOSED',
        isDraft: false,
        mergeable: 'UNKNOWN',
        mergeStateStatus: 'UNKNOWN',
      }),
    );
    const result = await prWaitCiGithub({ number: 45, poll_interval_sec: 5, timeout_sec: 60 });
    if (!('ok' in result) || !result.ok) throw new Error('expected ok');
    const data = result.data as { status?: string; mergeable?: boolean; blocker?: string };
    expect(data.status).toBe('no_checks_required');
    expect(data.mergeable).toBe(false);
    expect(data.blocker).toBe('closed');
  });

  test('non-empty rollup does NOT short-circuit — polled-response shape returned', async () => {
    // Regression — proves the addition is conditional on rollup.length === 0.
    onExec(
      'gh pr view',
      JSON.stringify({
        url: 'https://github.com/org/repo/pull/46',
        statusCheckRollup: [
          { __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' },
        ],
        state: 'OPEN',
        isDraft: false,
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
      }),
    );
    const result = await prWaitCiGithub({ number: 46, poll_interval_sec: 5, timeout_sec: 10 });
    if (!('ok' in result) || !result.ok) throw new Error('expected ok');
    const data = result.data as { status?: string; final_state?: string };
    expect(data.final_state).toBe('passed');
    expect(data.status).toBeUndefined();
  });
});

// --- pure mapper tests for the empty-rollup blocker classifier (#416) ------
describe('emptyRollupBlocker — pure mapping table', () => {
  test('OPEN + mergeable + not draft → null (no blocker)', () => {
    expect(emptyRollupBlocker({ state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' })).toBeNull();
  });

  test('OPEN + mergeable=true (boolean) → null', () => {
    expect(emptyRollupBlocker({ state: 'OPEN', isDraft: false, mergeable: true })).toBeNull();
  });

  test('CLOSED → closed', () => {
    expect(emptyRollupBlocker({ state: 'CLOSED', mergeable: 'MERGEABLE' })).toBe('closed');
  });

  test('MERGED → merged', () => {
    expect(emptyRollupBlocker({ state: 'MERGED', mergeable: 'MERGEABLE' })).toBe('merged');
  });

  test('isDraft=true → draft (even when mergeable)', () => {
    expect(emptyRollupBlocker({ state: 'OPEN', isDraft: true, mergeable: 'MERGEABLE' })).toBe('draft');
  });

  test('CONFLICTING → conflicts', () => {
    expect(emptyRollupBlocker({ state: 'OPEN', isDraft: false, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })).toBe('conflicts');
  });

  test('mergeable=UNKNOWN → not_mergeable (defensive)', () => {
    // GitHub returns UNKNOWN while it's still computing mergeability. We don't
    // promise the caller "yes mergeable" until GitHub has actually decided.
    expect(emptyRollupBlocker({ state: 'OPEN', isDraft: false, mergeable: 'UNKNOWN' })).toBe('not_mergeable');
  });

  test('mergeable=false (boolean) → not_mergeable', () => {
    expect(emptyRollupBlocker({ state: 'OPEN', isDraft: false, mergeable: false })).toBe('not_mergeable');
  });
});

describe('probeGithub — argv shape', () => {
  test('asks for statusCheckRollup,url,state,isDraft,mergeable,mergeStateStatus', () => {
    onExec(
      'gh pr view',
      JSON.stringify({
        url: 'https://github.com/org/repo/pull/1',
        statusCheckRollup: [],
        state: 'OPEN',
        isDraft: false,
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
      }),
    );
    probeGithub(1);
    const viewCall = execCalls().find((c) => c.startsWith('gh pr view')) ?? '';
    expect(viewCall).toContain('statusCheckRollup');
    expect(viewCall).toContain('url');
    expect(viewCall).toContain('state');
    expect(viewCall).toContain('isDraft');
    expect(viewCall).toContain('mergeable');
    expect(viewCall).toContain('mergeStateStatus');
  });
});

describe('prWaitCiGithub — failure surfaces as AdapterResult', () => {
  test('gh failure → ok:false, code unexpected_error', async () => {
    onExec('gh pr view', () => {
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
