import { describe, test, expect, beforeEach } from 'bun:test';
import {
  onExec,
  execCalls,
  resetExecMock,
  installChildProcessMock,
} from '../test-support/mock-child-process.ts';
import type { AdapterResult, PrStatusResponse } from './types.ts';
import type { RollupItem } from './pr-wait-ci-github.ts';

// Subprocess-boundary tests for the GitHub pr_status adapter (R-15).
// Integration-level coverage (handler dispatch, error envelope) stays in
// tests/pr_status.test.ts; this file owns the argv-shape and response-parsing
// assertions that prove the adapter speaks `gh` correctly, plus the
// aggregateRollup pass/fail/pending counting table.
//
// #491: checks come from `gh pr view --json ...,statusCheckRollup` — a SINGLE
// call. The adapter previously issued a second `gh pr checks --json`, a flag
// that does not exist on gh 2.45 (Ubuntu 24.04 LTS), and rendered that failure
// as `summary: 'none'`. Tests here lock the single-call shape and the
// fail-CLOSED behaviour that replaced the silent default.

interface ThrowableError extends Error {
  stderr?: string;
  stdout?: string;
  status?: number;
}

function unquote(cmd: string): string {
  return cmd.replace(/'([^']*)'/g, '$1');
}

installChildProcessMock();

const { prStatusGithub, aggregateRollup } = await import('./pr-status-github.ts');

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
  return execCalls().find((c) => c.includes(needle) || unquote(c).includes(needle)) ?? '';
}

/** A completed CheckRun in `statusCheckRollup` shape. */
function checkRun(name: string, conclusion: string): RollupItem {
  return { __typename: 'CheckRun', name, status: 'COMPLETED', conclusion };
}

/** Build a `gh pr view --json` payload including the rollup. */
function viewPayload(
  over: Partial<{
    state: string;
    mergeStateStatus: string;
    mergeable: string | boolean;
    url: string;
    statusCheckRollup: RollupItem[];
  }> = {},
): string {
  return JSON.stringify({
    state: 'OPEN',
    mergeStateStatus: 'CLEAN',
    mergeable: 'MERGEABLE',
    url: 'https://github.com/o/r/pull/1',
    statusCheckRollup: [],
    ...over,
  });
}

beforeEach(() => {
  resetExecMock();
});

describe('prStatusGithub — subprocess boundary', () => {
  test('gh CLI invocation matches expected argv shape (happy path)', async () => {
    onExec('gh pr view', viewPayload({ statusCheckRollup: [checkRun('validate', 'SUCCESS')] }));

    const result = await prStatusGithub({ number: 42 });
    expectOk(result);
    expect(result.data.number).toBe(42);

    const viewCall = findCall('gh pr view');
    expect(viewCall).toContain('42');
    expect(viewCall).toContain('--json');
    // #491: the rollup is requested on the SAME call as the PR fields.
    expect(viewCall).toContain('state,mergeStateStatus,mergeable,url,statusCheckRollup');
    expect(viewCall).not.toContain('--repo');
  });

  test('#491 regression: NEVER issues `gh pr checks` (flag absent on gh 2.45)', async () => {
    onExec('gh pr view', viewPayload({ statusCheckRollup: [checkRun('validate', 'SUCCESS')] }));

    const result = await prStatusGithub({ number: 42 });
    expectOk(result);

    // The defect: `gh pr checks --json` exits non-zero on the fleet's gh, and
    // the old code rendered that as `summary: 'none'`. Guard the argv directly,
    // mirroring the #220 guard that protects pr_wait_ci.
    expect(execCalls().find((c) => unquote(c).includes('gh pr checks'))).toBeUndefined();
    expect(execCalls().filter((c) => unquote(c).includes('gh pr view')).length).toBe(1);
  });

  test('parses view + rollup into PrStatusResponse', async () => {
    onExec(
      'gh pr view',
      viewPayload({
        url: 'https://github.com/o/r/pull/7',
        statusCheckRollup: [checkRun('a', 'SUCCESS'), checkRun('b', 'SUCCESS')],
      }),
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

  test('the treebeard case: 4 passing checks report as all_passed, not none', async () => {
    // The reported symptom (#491): pr_wait_ci said 4/4 passed while pr_status
    // said `none`, seconds apart, same PR.
    onExec(
      'gh pr view',
      viewPayload({
        statusCheckRollup: [
          checkRun('lint', 'SUCCESS'),
          checkRun('test', 'SUCCESS'),
          checkRun('build', 'SUCCESS'),
          checkRun('typecheck', 'SUCCESS'),
        ],
      }),
    );

    const result = await prStatusGithub({ number: 4 });
    expectOk(result);
    expect(result.data.checks.total).toBe(4);
    expect(result.data.checks.passed).toBe(4);
    expect(result.data.checks.summary).toBe('all_passed');
    expect(result.data.checks.summary).not.toBe('none');
  });

  test('boolean mergeable=true is honored alongside MERGEABLE string', async () => {
    onExec('gh pr view', viewPayload({ mergeable: true }));

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
      resetExecMock();
      onExec('gh pr view', viewPayload({ mergeStateStatus: status, mergeable: 'UNKNOWN' }));

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
      resetExecMock();
      onExec('gh pr view', viewPayload({ state: raw, mergeable: 'UNKNOWN' }));

      const result = await prStatusGithub({ number: 2 });
      expectOk(result);
      expect(result.data.state).toBe(expected);
    }
  });

  test('#491: a MISSING rollup fails CLOSED — never rendered as summary none', async () => {
    // This inverts the previous `gh pr checks failure is treated as no checks
    // (summary none)` test, which encoded the defect as intended behaviour.
    //
    // A missing field means the check state is UNKNOWN, not absent. Reporting
    // it as `none` is silent-permissive: /mmr halts on an {ok:false} envelope
    // but treats an unrecognised checks.summary as permission to merge, so an
    // error is the only representation that fails closed.
    onExec(
      'gh pr view',
      JSON.stringify({
        state: 'OPEN',
        mergeStateStatus: 'CLEAN',
        mergeable: 'MERGEABLE',
        url: 'https://github.com/o/r/pull/99',
        // statusCheckRollup deliberately absent
      }),
    );

    const result = await prStatusGithub({ number: 99 });
    expectErr(result);
    expect(result.code).toBe('gh_status_check_rollup_missing');
    expect(result.error).toContain('UNKNOWN, not absent');
  });

  test('#491: a null rollup also fails closed', async () => {
    onExec('gh pr view', JSON.stringify({
      state: 'OPEN',
      mergeStateStatus: 'CLEAN',
      mergeable: 'MERGEABLE',
      url: 'https://github.com/o/r/pull/98',
      statusCheckRollup: null,
    }));

    const result = await prStatusGithub({ number: 98 });
    expectErr(result);
    expect(result.code).toBe('gh_status_check_rollup_missing');
  });

  test('an EMPTY rollup is a genuine zero — summary none, still ok', async () => {
    // The distinction that matters: query succeeded and the PR really has no
    // checks. This must stay representable, and stay distinct from the
    // failure case above.
    onExec('gh pr view', viewPayload({ statusCheckRollup: [] }));

    const result = await prStatusGithub({ number: 11 });
    expectOk(result);
    expect(result.data.checks).toEqual({
      total: 0,
      passed: 0,
      failed: 0,
      pending: 0,
      summary: 'none',
    });
  });

  test('returns AdapterResult{ok:false, code} on gh pr view failure (not thrown)', async () => {
    onExec('gh pr view', () => {
      const err = new Error('gh: not found') as ThrowableError;
      err.stderr = 'gh: not found';
      err.status = 1;
      throw err;
    });

    const result = await prStatusGithub({ number: 404 });
    expectErr(result);
    expect(result.code).toBe('gh_pr_view_failed');
    // #493: the message reports what was queried and what came back, and names
    // this a FAILED QUERY rather than an empty result.
    expect(result.error).toContain('Could not determine');
    expect(result.error).toContain('FAILED QUERY, not an empty result');
    // ...and the verification hint is DERIVED from the argv that actually ran,
    // so it cannot describe a different query than the one performed.
    // renderArgv escapes per token so the command is copy-pasteable, hence
    // the quoted form here rather than a bare substring.
    expect(unquote(result.error)).toContain('gh pr view 404');
    expect(result.error).toContain('statusCheckRollup');
  });

  test('#493: unparseable stdout is a FAILED QUERY, not an empty result', async () => {
    // The other half of the defect class: the command SUCCEEDS but returns
    // garbage. Without this, `classifyRun`'s parse branch had zero coverage
    // while the adapter comment claimed it load-bearing.
    onExec('gh pr view', 'this is not json');

    const result = await prStatusGithub({ number: 77 });
    expectErr(result);
    expect(result.code).toBe('gh_pr_view_unparseable');
    // Distinct from an exec failure — same fail-closed direction, different cause.
    expect(result.code).not.toBe('gh_pr_view_failed');
    expect(result.error).toContain('FAILED QUERY, not an empty result');
    expect(result.error).toContain('unparseable output');
  });

  test('--repo flag forwarded into the single pr view call', async () => {
    onExec('gh pr view', viewPayload({ url: 'https://github.com/Org/Other/pull/5' }));

    await prStatusGithub({ number: 5, repo: 'Org/Other' });
    const viewCall = findCall('gh pr view');
    expect(viewCall).toContain('--repo');
    expect(viewCall).toContain('Org/Other');
    // There is no second call to forward it into any more.
    expect(execCalls().find((c) => unquote(c).includes('gh pr checks'))).toBeUndefined();
  });
});

describe('aggregateRollup helper', () => {
  test('empty list → summary none, all counts zero', () => {
    expect(aggregateRollup([])).toEqual({
      total: 0,
      passed: 0,
      failed: 0,
      pending: 0,
      summary: 'none',
    });
  });

  test('all successful → all_passed', () => {
    expect(aggregateRollup([checkRun('a', 'SUCCESS'), checkRun('b', 'SUCCESS')])).toEqual({
      total: 2,
      passed: 2,
      failed: 0,
      pending: 0,
      summary: 'all_passed',
    });
  });

  test('any failure → has_failures, and failures outrank pending', () => {
    const agg = aggregateRollup([
      checkRun('a', 'SUCCESS'),
      checkRun('b', 'FAILURE'),
      { __typename: 'CheckRun', name: 'c', status: 'IN_PROGRESS' },
    ]);
    expect(agg.failed).toBe(1);
    expect(agg.pending).toBe(1);
    expect(agg.summary).toBe('has_failures');
  });

  test('incomplete runs count pending → summary pending', () => {
    const agg = aggregateRollup([
      checkRun('a', 'SUCCESS'),
      { __typename: 'CheckRun', name: 'b', status: 'QUEUED' },
    ]);
    expect(agg).toEqual({
      total: 2,
      passed: 1,
      failed: 0,
      pending: 1,
      summary: 'pending',
    });
  });

  test('SKIPPED / STALE count as passed, not blockers', () => {
    const agg = aggregateRollup([checkRun('a', 'SKIPPED'), checkRun('b', 'STALE')]);
    expect(agg.passed).toBe(2);
    expect(agg.summary).toBe('all_passed');
  });

  test('legacy StatusContext items are classified too', () => {
    const agg = aggregateRollup([
      { __typename: 'StatusContext', name: 'legacy-ok', state: 'SUCCESS' },
      { __typename: 'StatusContext', name: 'legacy-bad', state: 'FAILURE' },
    ]);
    expect(agg.passed).toBe(1);
    expect(agg.failed).toBe(1);
    expect(agg.summary).toBe('has_failures');
  });

  test('unknown __typename defaults to pending — never decides on what it cannot classify', () => {
    const agg = aggregateRollup([{ __typename: 'SomethingNew', name: 'x' }]);
    expect(agg.pending).toBe(1);
    expect(agg.summary).toBe('pending');
  });
});
