import { describe, test, expect, mock, beforeEach } from 'bun:test';

// --- Mock child_process for the real-deps path (execute) ---------------------

let execMockFn: (cmd: string) => string = () => '';
let execCalls: string[] = [];
const mockExecSync = mock((cmd: string, _opts?: unknown) => {
  execCalls.push(cmd);
  return execMockFn(cmd);
});
mock.module('child_process', () => ({ execSync: mockExecSync }));

// Import AFTER the module mock is registered.
import type { ChecksSnapshot } from '../handlers/pr_wait_ci.ts';
const mod = await import('../handlers/pr_wait_ci.ts');
const handler = mod.default;
const runWithDeps = mod.__runWithDeps;
const classifyRollupItem = mod.classifyRollupItem;

beforeEach(() => {
  execMockFn = () => '';
  execCalls = [];
  mockExecSync.mockClear();
});

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

// Virtual clock + scripted snapshot sequence for deterministic loop tests.
function makeDeps(sequence: ChecksSnapshot[], intervalSec: number) {
  let now = 0;
  let idx = 0;
  const snapshotCalls: number[] = [];
  const sleepCalls: number[] = [];

  const deps: {
    snapshotFn: (n: number) => ChecksSnapshot;
    sleepFn: (ms: number) => Promise<void>;
    nowFn: () => number;
    heartbeatFn?: (number: number, attempt: number, snap: ChecksSnapshot) => void;
  } = {
    snapshotFn: (_n: number) => {
      snapshotCalls.push(now);
      // Last element sticks if we run past the script end.
      const snap = sequence[Math.min(idx, sequence.length - 1)];
      idx++;
      return snap;
    },
    sleepFn: async (ms: number) => {
      sleepCalls.push(ms);
      now += ms;
    },
    nowFn: () => now,
  };

  return { deps, snapshotCalls, sleepCalls, getNow: () => now, intervalSec };
}

function snap(
  partial: Partial<ChecksSnapshot> & { total: number },
): ChecksSnapshot {
  return {
    passed: 0,
    failed: 0,
    pending: 0,
    summary: 'test',
    url: 'https://example/pr/1',
    ...partial,
  };
}

describe('pr_wait_ci handler', () => {
  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('pr_wait_ci');
    expect(typeof handler.execute).toBe('function');
  });

  test('passed — all checks succeed after two polls', async () => {
    const { deps, snapshotCalls, sleepCalls } = makeDeps(
      [
        snap({ total: 3, passed: 1, pending: 2 }),
        snap({ total: 3, passed: 2, pending: 1 }),
        snap({ total: 3, passed: 3, pending: 0, summary: '3/3 passed' }),
      ],
      5,
    );

    const result = await runWithDeps(
      { number: 42, poll_interval_sec: 5, timeout_sec: 600 },
      deps,
    );

    expect(result.ok).toBe(true);
    expect(result.final_state).toBe('passed');
    expect(result.number).toBe(42);
    expect(result.checks.total).toBe(3);
    expect(result.checks.passed).toBe(3);
    expect(result.checks.pending).toBe(0);
    expect(snapshotCalls.length).toBe(3);
    expect(sleepCalls.length).toBe(2); // slept twice between the 3 snapshots
    expect(sleepCalls.every((ms) => ms === 5000)).toBe(true);
  });

  test('failed — any failing check terminates immediately', async () => {
    const { deps, snapshotCalls } = makeDeps(
      [
        snap({ total: 5, passed: 1, pending: 4 }),
        // Second poll: one check went red while others still pending.
        // Must NOT wait for others to finish.
        snap({ total: 5, passed: 1, failed: 1, pending: 3 }),
        // This should never be consumed.
        snap({ total: 5, passed: 5, pending: 0 }),
      ],
      5,
    );

    const result = await runWithDeps(
      { number: 7, poll_interval_sec: 5, timeout_sec: 600 },
      deps,
    );

    expect(result.final_state).toBe('failed');
    expect(result.checks.failed).toBe(1);
    expect(result.checks.pending).toBe(3); // proves we didn't wait
    expect(snapshotCalls.length).toBe(2);
  });

  // --- regression for #221: all checks SKIPPED → passed on first poll ---
  // Previously deadlocked because `decide` required `passed >= 1`. Common
  // for docs-only PRs in repos with conditional CI: every workflow has an
  // `if:` guard that doesn't match → all jobs SKIPPED → uncounted in
  // passed/failed/pending → loop spins to timeout for no reason.
  test('passed — all checks skipped (passed=0, failed=0, pending=0) → passed on first poll', async () => {
    const allSkipped = snap({ total: 3, passed: 0, failed: 0, pending: 0, summary: '0/3 (all skipped)' });
    const { deps, snapshotCalls, sleepCalls } = makeDeps([allSkipped], 5);

    const result = await runWithDeps(
      { number: 1, poll_interval_sec: 5, timeout_sec: 600 },
      deps,
    );

    expect(result.final_state).toBe('passed');
    expect(result.checks.passed).toBe(0);
    expect(result.checks.total).toBe(3);
    expect(snapshotCalls.length).toBe(1); // proves first poll terminated
    expect(sleepCalls.length).toBe(0);    // no sleep needed
  });

  test('timed_out — loop exits when elapsed > timeout', async () => {
    // Every snapshot stays pending forever.
    const stuck = snap({ total: 2, passed: 0, pending: 2 });
    const { deps, snapshotCalls } = makeDeps([stuck], 5);

    const result = await runWithDeps(
      { number: 99, poll_interval_sec: 5, timeout_sec: 15 },
      deps,
    );

    expect(result.final_state).toBe('timed_out');
    expect(result.checks.pending).toBe(2);
    expect(result.waited_sec).toBeGreaterThanOrEqual(15);
    // With a 15s budget and 5s interval, we expect ~3-4 snapshots.
    expect(snapshotCalls.length).toBeGreaterThanOrEqual(3);
    expect(snapshotCalls.length).toBeLessThanOrEqual(5);
  });

  test('poll_interval_sec hard floor — rejects values below 5', async () => {
    const result = await handler.execute({
      number: 1,
      poll_interval_sec: 2,
      timeout_sec: 60,
    });
    const data = parseResult(result);
    expect(data.ok).toBe(false);
    expect((data.error as string)).toContain('>= 5');
  });

  test('poll_interval_sec at floor (5s) is accepted', async () => {
    const { deps } = makeDeps(
      [snap({ total: 1, passed: 1, pending: 0 })],
      5,
    );

    const result = await runWithDeps(
      { number: 1, poll_interval_sec: 5, timeout_sec: 60 },
      deps,
    );
    expect(result.final_state).toBe('passed');
  });

  test('defaults — poll_interval_sec=30 and timeout_sec=1800 when omitted', async () => {
    // Just validate the schema passes and uses defaults via runWithDeps.
    const { deps, sleepCalls } = makeDeps(
      [
        snap({ total: 1, passed: 0, pending: 1 }),
        snap({ total: 1, passed: 1, pending: 0 }),
      ],
      30,
    );

    const result = await runWithDeps({ number: 1 }, deps);
    expect(result.final_state).toBe('passed');
    expect(sleepCalls[0]).toBe(30_000);
  });

  test('schema_validation — rejects unknown fields', async () => {
    const result = await handler.execute({ number: 1, foo: 'bar' });
    const data = parseResult(result);
    expect(data.ok).toBe(false);
  });

  test('schema_validation — requires number', async () => {
    const result = await handler.execute({});
    const data = parseResult(result);
    expect(data.ok).toBe(false);
  });

  test('execute — end-to-end with mocked execSync (github pass path)', async () => {
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote'))
        return 'https://github.com/org/repo.git\n';
      if (cmd.startsWith('gh pr view'))
        return JSON.stringify({
          url: 'https://github.com/org/repo/pull/5',
          statusCheckRollup: [
            { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
            { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
          ],
        });
      throw new Error(`unexpected exec: ${cmd}`);
    };

    // Use a very small timeout; the very first snapshot should return passed.
    const result = await handler.execute({
      number: 5,
      poll_interval_sec: 5,
      timeout_sec: 10,
    });
    const data = parseResult(result);
    expect(data.ok).toBe(true);
    expect(data.final_state).toBe('passed');
    expect(data.url).toBe('https://github.com/org/repo/pull/5');
    const checks = data.checks as Record<string, number | string>;
    expect(checks.passed).toBe(2);
    expect(checks.failed).toBe(0);
  });

  test('execute — end-to-end with mocked execSync (github fail path)', async () => {
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote'))
        return 'https://github.com/org/repo.git\n';
      if (cmd.startsWith('gh pr view'))
        return JSON.stringify({
          url: 'https://github.com/org/repo/pull/9',
          statusCheckRollup: [
            { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
            { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' },
            { __typename: 'CheckRun', name: 'test', status: 'IN_PROGRESS' },
          ],
        });
      throw new Error(`unexpected exec: ${cmd}`);
    };

    const result = await handler.execute({
      number: 9,
      poll_interval_sec: 5,
      timeout_sec: 10,
    });
    const data = parseResult(result);
    expect(data.ok).toBe(true);
    expect(data.final_state).toBe('failed');
    const checks = data.checks as Record<string, number>;
    expect(checks.failed).toBe(1);
    expect(checks.pending).toBe(1); // proves early termination preserved state
  });

  test('heartbeatFn called on each poll iteration with correct args', async () => {
    const heartbeatCalls: Array<{ number: number; attempt: number; total: number }> = [];
    const { deps } = makeDeps(
      [
        snap({ total: 3, passed: 1, pending: 2 }),
        snap({ total: 3, passed: 2, pending: 1 }),
        snap({ total: 3, passed: 3, pending: 0 }),
      ],
      5,
    );

    deps.heartbeatFn = (number: number, attempt: number, s: ChecksSnapshot) => {
      heartbeatCalls.push({ number, attempt, total: s.total });
    };

    const result = await runWithDeps(
      { number: 42, poll_interval_sec: 5, timeout_sec: 600 },
      deps,
    );

    expect(result.final_state).toBe('passed');
    // 3 snapshots → 3 heartbeat calls
    expect(heartbeatCalls).toHaveLength(3);
    expect(heartbeatCalls[0]).toEqual({ number: 42, attempt: 1, total: 3 });
    expect(heartbeatCalls[1]).toEqual({ number: 42, attempt: 2, total: 3 });
    expect(heartbeatCalls[2]).toEqual({ number: 42, attempt: 3, total: 3 });
  });

  test('heartbeatFn omitted — poll loop still works', async () => {
    const { deps } = makeDeps(
      [snap({ total: 1, passed: 1, pending: 0 })],
      5,
    );
    // Explicitly set heartbeatFn to undefined
    deps.heartbeatFn = undefined;

    const result = await runWithDeps(
      { number: 1, poll_interval_sec: 5, timeout_sec: 60 },
      deps,
    );
    expect(result.final_state).toBe('passed');
  });

  test('execute — gitlab mr with successful pipeline', async () => {
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote'))
        return 'https://gitlab.com/org/repo.git\n';
      if (cmd.includes('glab api projects/org%2Frepo/merge_requests/3'))
        return JSON.stringify({
          iid: 3,
          web_url: 'https://gitlab.com/org/repo/-/merge_requests/3',
          head_pipeline: { status: 'success' },
          title: 'Test MR',
          description: '',
          state: 'opened',
          source_branch: 'feature/test',
          target_branch: 'main',
          labels: [],
        });
      throw new Error(`unexpected exec: ${cmd}`);
    };

    const result = await handler.execute({
      number: 3,
      poll_interval_sec: 5,
      timeout_sec: 10,
    });
    const data = parseResult(result);
    expect(data.ok).toBe(true);
    expect(data.final_state).toBe('passed');
    expect(data.url).toBe('https://gitlab.com/org/repo/-/merge_requests/3');
  });

  // --- cross-repo routing ---

  test('route_with_repo — github threads --repo into the gh pr view call', async () => {
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote'))
        return 'https://github.com/cwd-org/cwd-repo.git\n';
      if (cmd.startsWith('gh pr view'))
        return JSON.stringify({
          url: 'https://github.com/Wave-Engineering/mcp-server-sdlc/pull/5',
          statusCheckRollup: [
            { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
          ],
        });
      throw new Error(`unexpected exec: ${cmd}`);
    };

    const result = await handler.execute({
      number: 5,
      poll_interval_sec: 5,
      timeout_sec: 10,
      repo: 'Wave-Engineering/mcp-server-sdlc',
    });
    const data = parseResult(result);
    expect(data.ok).toBe(true);
    expect(data.final_state).toBe('passed');

    const viewCall = execCalls.find((c) => c.startsWith('gh pr view')) ?? '';
    expect(viewCall).toContain('--repo Wave-Engineering/mcp-server-sdlc');
    // Regression guard for #220: snapshotGithub must not invoke the broken
    // `gh pr checks --json` form, which fails on gh < ~2.50 (Ubuntu LTS).
    expect(execCalls.some((c) => c.startsWith('gh pr checks'))).toBe(false);
  });

  test('route_with_repo — gitlab forwards slug into glab api URL path', async () => {
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote'))
        return 'https://gitlab.com/cwd-org/cwd-repo.git\n';
      if (cmd.includes('glab api projects/target-org%2Ftarget-repo/merge_requests/3'))
        return JSON.stringify({
          iid: 3,
          web_url: 'https://gitlab.com/target-org/target-repo/-/merge_requests/3',
          head_pipeline: { status: 'success' },
          title: 'Test MR',
          description: '',
          state: 'opened',
          source_branch: 'feature/test',
          target_branch: 'main',
          labels: [],
        });
      throw new Error(`unexpected exec: ${cmd}`);
    };

    const result = await handler.execute({
      number: 3,
      poll_interval_sec: 5,
      timeout_sec: 10,
      repo: 'target-org/target-repo',
    });
    const data = parseResult(result);
    expect(data.ok).toBe(true);
    expect(data.final_state).toBe('passed');

    const apiCall = execCalls.find((c) => c.includes('glab api projects/')) ?? '';
    expect(apiCall).toContain('target-org%2Ftarget-repo');
    expect(apiCall).not.toContain('cwd-org%2Fcwd-repo');
  });

  test('regression_without_repo — gh pr view does not contain --repo when omitted', async () => {
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote'))
        return 'https://github.com/org/repo.git\n';
      if (cmd.startsWith('gh pr view'))
        return JSON.stringify({
          url: 'https://github.com/org/repo/pull/5',
          statusCheckRollup: [
            { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
          ],
        });
      throw new Error(`unexpected exec: ${cmd}`);
    };

    await handler.execute({
      number: 5,
      poll_interval_sec: 5,
      timeout_sec: 10,
    });

    const viewCall = execCalls.find((c) => c.startsWith('gh pr view')) ?? '';
    expect(viewCall).not.toContain('--repo');
  });

  test('invalid_slug_early_error — returns ok:false with zero exec calls', async () => {
    const result = await handler.execute({
      number: 1,
      poll_interval_sec: 5,
      timeout_sec: 10,
      repo: 'not-a-slug',
    });
    const data = parseResult(result);

    expect(data.ok).toBe(false);
    expect(typeof data.error).toBe('string');
    expect(execCalls).toHaveLength(0);
  });

  // --- classifyRollupItem (pure mapper) — covers every branch of the table
  // documented in the function's JSDoc. Pure tests so the mapping table can
  // be exercised without a subprocess. ---

  test('classifyRollupItem: CheckRun COMPLETED+SUCCESS → pass', () => {
    expect(classifyRollupItem({ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' })).toBe('pass');
  });

  test('classifyRollupItem: CheckRun COMPLETED+NEUTRAL → pass', () => {
    expect(classifyRollupItem({ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'NEUTRAL' })).toBe('pass');
  });

  test('classifyRollupItem: CheckRun COMPLETED+FAILURE → fail', () => {
    expect(classifyRollupItem({ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' })).toBe('fail');
  });

  test('classifyRollupItem: CheckRun COMPLETED+CANCELLED → fail (preserves prior cancel→fail mapping)', () => {
    expect(classifyRollupItem({ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'CANCELLED' })).toBe('fail');
  });

  test('classifyRollupItem: CheckRun COMPLETED+TIMED_OUT → fail', () => {
    expect(classifyRollupItem({ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'TIMED_OUT' })).toBe('fail');
  });

  test('classifyRollupItem: CheckRun COMPLETED+STARTUP_FAILURE → fail', () => {
    expect(classifyRollupItem({ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'STARTUP_FAILURE' })).toBe('fail');
  });

  // ACTION_REQUIRED means a workflow paused for a human approval gate
  // (e.g. environment protection rule). For autopilot callers (/scpmmr,
  // wave-machine), it's terminal in the same way as a hard failure — the
  // merge cannot proceed without manual intervention. Treating it as
  // "pending" would silently burn the timeout budget waiting for a human.
  test('classifyRollupItem: CheckRun COMPLETED+ACTION_REQUIRED → fail (deliberate; needs human, not patience)', () => {
    expect(classifyRollupItem({ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'ACTION_REQUIRED' })).toBe('fail');
  });

  test('classifyRollupItem: CheckRun IN_PROGRESS → pending (status not COMPLETED)', () => {
    expect(classifyRollupItem({ __typename: 'CheckRun', status: 'IN_PROGRESS' })).toBe('pending');
  });

  test('classifyRollupItem: CheckRun QUEUED → pending', () => {
    expect(classifyRollupItem({ __typename: 'CheckRun', status: 'QUEUED' })).toBe('pending');
  });

  test('classifyRollupItem: CheckRun COMPLETED+SKIPPED → skipping (uncounted)', () => {
    expect(classifyRollupItem({ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SKIPPED' })).toBe('skipping');
  });

  test('classifyRollupItem: CheckRun COMPLETED+STALE → skipping (uncounted)', () => {
    expect(classifyRollupItem({ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'STALE' })).toBe('skipping');
  });

  test('classifyRollupItem: StatusContext SUCCESS → pass', () => {
    expect(classifyRollupItem({ __typename: 'StatusContext', state: 'SUCCESS' })).toBe('pass');
  });

  test('classifyRollupItem: StatusContext PENDING → pending', () => {
    expect(classifyRollupItem({ __typename: 'StatusContext', state: 'PENDING' })).toBe('pending');
  });

  test('classifyRollupItem: StatusContext FAILURE → fail', () => {
    expect(classifyRollupItem({ __typename: 'StatusContext', state: 'FAILURE' })).toBe('fail');
  });

  test('classifyRollupItem: StatusContext ERROR → fail', () => {
    expect(classifyRollupItem({ __typename: 'StatusContext', state: 'ERROR' })).toBe('fail');
  });

  test('classifyRollupItem: unknown __typename → pending (defensive default)', () => {
    expect(classifyRollupItem({ __typename: 'FutureCheckType', status: 'COMPLETED', conclusion: 'SUCCESS' })).toBe('pending');
    expect(classifyRollupItem({})).toBe('pending');
  });

  // --- snapshotGithub end-to-end with mixed CheckRun + StatusContext ---
  // Realistic payload mixing modern Actions + legacy commit statuses + a
  // SKIPPED check (uncounted) and one failure so the loop terminates on the
  // first poll. Verifies the count math in snapshotGithub.
  test('execute — counts mixed CheckRun + StatusContext + SKIPPED correctly', async () => {
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote'))
        return 'https://github.com/org/repo.git\n';
      if (cmd.startsWith('gh pr view'))
        return JSON.stringify({
          url: 'https://github.com/org/repo/pull/77',
          statusCheckRollup: [
            { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
            { __typename: 'CheckRun', name: 'optional', status: 'COMPLETED', conclusion: 'SKIPPED' },
            { __typename: 'StatusContext', context: 'codecov/patch', state: 'SUCCESS' },
            { __typename: 'StatusContext', context: 'license/cla', state: 'PENDING' },
            { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' },
          ],
        });
      throw new Error(`unexpected exec: ${cmd}`);
    };

    const result = await handler.execute({
      number: 77,
      poll_interval_sec: 5,
      timeout_sec: 10,
    });
    const data = parseResult(result);
    // Loop terminates on first poll because failed > 0.
    expect(data.ok).toBe(true);
    expect(data.final_state).toBe('failed');
    const checks = data.checks as Record<string, number | string>;
    expect(checks.passed).toBe(2);     // build + codecov
    expect(checks.failed).toBe(1);     // lint
    expect(checks.pending).toBe(1);    // license/cla
    expect(checks.total).toBe(5);      // total INCLUDES the SKIPPED entry
  });

  // --- regression: stub explicitly REJECTS the broken `gh pr checks --json`
  // form per `lesson_origin_ops_pitfalls.md`. If a future refactor ever brings
  // back the gh-version-incompatible call, this test fires immediately. ---
  test('argv-regression: stub rejects gh pr checks --json (broken on gh 2.45) — #220', async () => {
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote'))
        return 'https://github.com/org/repo.git\n';
      if (/^gh pr checks\b/.test(cmd) && cmd.includes('--json')) {
        throw new Error(`Stub rejection (#220 regression): handler invoked broken \`gh pr checks --json\` form. Use \`gh pr view --json statusCheckRollup\` instead. cmd=${cmd}`);
      }
      if (cmd.startsWith('gh pr view'))
        return JSON.stringify({
          url: 'https://github.com/org/repo/pull/1',
          statusCheckRollup: [
            { __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' },
          ],
        });
      throw new Error(`unexpected exec: ${cmd}`);
    };

    const result = await handler.execute({
      number: 1,
      poll_interval_sec: 5,
      timeout_sec: 10,
    });
    const data = parseResult(result);
    expect(data.ok).toBe(true);
    expect(data.final_state).toBe('passed');
  });

  test('strict_schema_accepts_repo — .strict() schema does not reject new field', async () => {
    // Proof that adding repo to a .strict() schema doesn't trigger InvalidParams
    // via the real MCP dispatch surface (handler.execute), not just the test seam.
    // If `repo` wasn't declared inside the .strict() object, Zod would reject at
    // inputSchema.parse() and execute() would return ok:false with "repo" in the
    // error message. Here we just need the parse to succeed and the handler to
    // run — we don't care about the poll outcome.
    execMockFn = (cmd: string) => {
      if (cmd.includes('gh pr view')) {
        return JSON.stringify({
          url: 'https://github.com/owner/repo/pull/1',
          statusCheckRollup: [
            { __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' },
          ],
        });
      }
      return '';
    };

    const result = await handler.execute({
      number: 1,
      poll_interval_sec: 5,
      timeout_sec: 10,
      repo: 'owner/repo',
    });
    const data = parseResult(result);
    // ok:true proves the .strict() schema accepted `repo`; if it had rejected,
    // data.ok would be false with an error mentioning the unexpected field.
    expect(data.ok).toBe(true);
    expect(typeof data.error).toBe('undefined');
  });
});
