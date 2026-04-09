import { describe, test, expect, mock, beforeEach } from 'bun:test';

// --- Mock child_process for the real-deps path (execute) ---------------------

let execMockFn: (cmd: string) => string = () => '';
const mockExecSync = mock((cmd: string, _opts?: unknown) => execMockFn(cmd));
mock.module('child_process', () => ({ execSync: mockExecSync }));

// Import AFTER the module mock is registered.
import type { ChecksSnapshot } from '../handlers/pr_wait_ci.ts';
const mod = await import('../handlers/pr_wait_ci.ts');
const handler = mod.default;
const runWithDeps = mod.__runWithDeps;

beforeEach(() => {
  execMockFn = () => '';
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

  const deps = {
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
      if (cmd.startsWith('gh pr checks'))
        return JSON.stringify([
          { name: 'build', bucket: 'pass', state: 'SUCCESS' },
          { name: 'test', bucket: 'pass', state: 'SUCCESS' },
        ]);
      if (cmd.startsWith('gh pr view'))
        return JSON.stringify({ url: 'https://github.com/org/repo/pull/5' });
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
      if (cmd.startsWith('gh pr checks'))
        return JSON.stringify([
          { name: 'build', bucket: 'pass' },
          { name: 'lint', bucket: 'fail' },
          { name: 'test', bucket: 'pending' },
        ]);
      if (cmd.startsWith('gh pr view'))
        return JSON.stringify({ url: 'https://github.com/org/repo/pull/9' });
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
});
