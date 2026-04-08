import { describe, test, expect, mock, beforeEach } from 'bun:test';

// --- Mock child_process.execSync at module level ---
// Each registry entry can be either:
//   - a string (sticky: returned on every matching call)
//   - an array of strings (sequence: consumed one per matching call; last value sticks)
// Entries are matched by `cmd.includes(key)`. Longer keys win to disambiguate.

type RegistryValue = string | string[];
let execRegistry: Record<string, RegistryValue> = {};
let execCallLog: string[] = [];

function mockExec(cmd: string): string {
  execCallLog.push(cmd);
  const keys = Object.keys(execRegistry).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (cmd.includes(key)) {
      const value = execRegistry[key];
      if (Array.isArray(value)) {
        if (value.length === 0) {
          throw new Error(`exec sequence for key '${key}' exhausted (cmd: ${cmd})`);
        }
        if (value.length === 1) return value[0];
        return value.shift() as string;
      }
      return value;
    }
  }
  throw new Error(`Unexpected exec call: ${cmd}`);
}

mock.module('child_process', () => ({
  execSync: (cmd: string, _opts?: unknown) => mockExec(cmd),
}));

// Import AFTER the mock is registered.
const handlerMod = await import('../handlers/ci_wait_run.ts');
const ciWaitRunHandler = handlerMod.default;
const { __setSleep, __resetSleep } = handlerMod;

function parseResult(content: Array<{ type: string; text: string }>) {
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

// Helpers to construct fake gh/glab output.
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
    ...overrides,
  };
}

function glabPipeline(overrides: Record<string, unknown> = {}) {
  return {
    id: 999,
    status: 'running',
    ref: 'feature/1-demo',
    sha: '1234567890abcdef1234567890abcdef12345678',
    web_url: 'https://gitlab.com/org/repo/-/pipelines/999',
    name: 'CI',
    created_at: '2026-04-07T12:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  execRegistry = {};
  execCallLog = [];
  // No-op sleep so tests run instantly.
  __setSleep(async (_ms: number) => {
    // intentionally empty
  });
});

describe('ci_wait_run handler', () => {
  // --- zod validation: ref required ---
  test('missing ref — returns validation error', async () => {
    const result = await ciWaitRunHandler.execute({});
    const data = parseResult(result.content);
    expect(data.ok).toBe(false);
    expect(typeof data.error).toBe('string');
  });

  // --- hard floor on poll_interval_sec ---
  test('poll_interval_sec hard floor — values below 5 are clamped to 5', async () => {
    // Set up a sequence: first poll in_progress, second poll completed/success.
    // We capture the sleep ms argument to confirm the clamped value is used.
    const sleeps: number[] = [];
    __setSleep(async (ms: number) => {
      sleeps.push(ms);
    });
    execRegistry['git remote get-url origin'] = 'https://github.com/org/repo.git';
    execRegistry['gh run list'] = [
      JSON.stringify([ghRun({ status: 'in_progress' })]),
      JSON.stringify([ghRun({ status: 'completed', conclusion: 'success' })]),
    ];

    const result = await ciWaitRunHandler.execute({
      ref: 'main',
      poll_interval_sec: 1, // below floor
    });
    const data = parseResult(result.content);
    expect(data.ok).toBe(true);
    expect(data.final_status).toBe('success');
    // At least one sleep at 5000ms (the clamped floor) — ignore the 5000 no-run-yet sleeps.
    const mainLoopSleeps = sleeps.filter((ms) => ms === 5000);
    expect(mainLoopSleeps.length).toBeGreaterThan(0);
  });

  // --- no-run-then-success: first several polls return empty, then run appears and succeeds ---
  test('no_run_then_success — waits for run to appear, then polls to success', async () => {
    execRegistry['git remote get-url origin'] = 'https://github.com/org/repo.git';
    execRegistry['gh run list'] = [
      JSON.stringify([]), // no run yet
      JSON.stringify([]), // still no run
      JSON.stringify([ghRun({ status: 'in_progress' })]), // run appears, in progress
      JSON.stringify([ghRun({ status: 'completed', conclusion: 'success' })]),
    ];

    const result = await ciWaitRunHandler.execute({ ref: 'main' });
    const data = parseResult(result.content);
    expect(data.ok).toBe(true);
    expect(data.final_status).toBe('success');
    expect(data.run_id).toBe(12345);
    expect(data.workflow_name).toBe('CI');
  });

  // --- immediate-failure: run is already completed with failure conclusion on first poll ---
  test('immediate_failure — run completed on first poll with failure', async () => {
    execRegistry['git remote get-url origin'] = 'https://github.com/org/repo.git';
    execRegistry['gh run list'] = JSON.stringify([
      ghRun({ status: 'completed', conclusion: 'failure' }),
    ]);

    const result = await ciWaitRunHandler.execute({ ref: 'main' });
    const data = parseResult(result.content);
    expect(data.ok).toBe(true);
    expect(data.final_status).toBe('failure');
  });

  // --- cancelled termination ---
  test('cancelled — conclusion=cancelled maps to final_status=cancelled', async () => {
    execRegistry['git remote get-url origin'] = 'https://github.com/org/repo.git';
    execRegistry['gh run list'] = JSON.stringify([
      ghRun({ status: 'completed', conclusion: 'cancelled' }),
    ]);

    const result = await ciWaitRunHandler.execute({ ref: 'main' });
    const data = parseResult(result.content);
    expect(data.ok).toBe(true);
    expect(data.final_status).toBe('cancelled');
  });

  // --- long-timeout: run never completes, tool times out ---
  test('long_timeout — run stays in_progress, returns timed_out after timeout_sec', async () => {
    // We drive the clock by making sleepFn advance a fake clock. But a simpler
    // approach: make the sleep bump a counter of fake elapsed time that the handler
    // observes via the real Date.now. Instead, we stub setTimeout via advancing
    // the real Date.now through `__setSleep`.
    const realDateNow = Date.now;
    let fakeNow = realDateNow();
    Date.now = () => fakeNow;
    __setSleep(async (ms: number) => {
      fakeNow += ms;
    });

    try {
      execRegistry['git remote get-url origin'] = 'https://github.com/org/repo.git';
      // Always in_progress — sticky.
      execRegistry['gh run list'] = JSON.stringify([
        ghRun({ status: 'in_progress' }),
      ]);

      const result = await ciWaitRunHandler.execute({
        ref: 'main',
        poll_interval_sec: 10,
        timeout_sec: 30, // tight so we don't loop forever
      });
      const data = parseResult(result.content);
      expect(data.ok).toBe(true);
      expect(data.final_status).toBe('timed_out');
      expect(typeof data.waited_sec).toBe('number');
      expect(data.waited_sec as number).toBeGreaterThanOrEqual(30);
    } finally {
      Date.now = realDateNow;
    }
  });

  // --- workflow filter: only matching workflow is picked ---
  test('workflow_filter — picks only runs matching workflow_name', async () => {
    execRegistry['git remote get-url origin'] = 'https://github.com/org/repo.git';
    // Return two runs; the filter should pick only the second.
    execRegistry['gh run list'] = JSON.stringify([
      ghRun({
        databaseId: 111,
        workflowName: 'Lint',
        name: 'Lint',
        status: 'in_progress',
      }),
      ghRun({
        databaseId: 222,
        workflowName: 'Build',
        name: 'Build',
        status: 'completed',
        conclusion: 'success',
      }),
    ]);

    const result = await ciWaitRunHandler.execute({
      ref: 'main',
      workflow_name: 'Build',
    });
    const data = parseResult(result.content);
    expect(data.ok).toBe(true);
    expect(data.run_id).toBe(222);
    expect(data.workflow_name).toBe('Build');
    expect(data.final_status).toBe('success');
  });

  // --- workflow filter: no matching workflow → no-run-yet treatment → timeout error ---
  test('workflow_filter_no_match — no matching workflow results in no-run-found error', async () => {
    // Advance fake clock past the no-run-yet window and timeout quickly.
    const realDateNow = Date.now;
    let fakeNow = realDateNow();
    Date.now = () => fakeNow;
    __setSleep(async (ms: number) => {
      fakeNow += ms;
    });
    try {
      execRegistry['git remote get-url origin'] = 'https://github.com/org/repo.git';
      execRegistry['gh run list'] = JSON.stringify([
        ghRun({ workflowName: 'Lint', name: 'Lint', status: 'in_progress' }),
      ]);

      const result = await ciWaitRunHandler.execute({
        ref: 'main',
        workflow_name: 'NonExistent',
        timeout_sec: 30,
      });
      const data = parseResult(result.content);
      expect(data.ok).toBe(false);
      expect((data.error as string).toLowerCase()).toContain('no ci run found');
      expect((data.error as string)).toContain('NonExistent');
    } finally {
      Date.now = realDateNow;
    }
  });

  // --- SHA ref detection: 40-char hex uses --commit flag ---
  test('sha_ref_detection — 40-char hex ref uses --commit flag', async () => {
    const sha = 'a'.repeat(40);
    execRegistry['git remote get-url origin'] = 'https://github.com/org/repo.git';
    execRegistry['gh run list'] = JSON.stringify([
      ghRun({ status: 'completed', conclusion: 'success', headSha: sha }),
    ]);

    const result = await ciWaitRunHandler.execute({ ref: sha });
    const data = parseResult(result.content);
    expect(data.ok).toBe(true);
    // Verify the exec call used --commit, not --branch.
    const ghCalls = execCallLog.filter((c) => c.startsWith('gh run list'));
    expect(ghCalls.length).toBeGreaterThan(0);
    expect(ghCalls[0]).toContain('--commit');
    expect(ghCalls[0]).not.toContain('--branch');
  });

  // --- Branch ref detection: non-hex uses --branch flag ---
  test('branch_ref_detection — branch name uses --branch flag', async () => {
    execRegistry['git remote get-url origin'] = 'https://github.com/org/repo.git';
    execRegistry['gh run list'] = JSON.stringify([
      ghRun({ status: 'completed', conclusion: 'success' }),
    ]);

    const result = await ciWaitRunHandler.execute({ ref: 'feature/1-demo' });
    const data = parseResult(result.content);
    expect(data.ok).toBe(true);
    const ghCalls = execCallLog.filter((c) => c.startsWith('gh run list'));
    expect(ghCalls.length).toBeGreaterThan(0);
    expect(ghCalls[0]).toContain('--branch');
    expect(ghCalls[0]).not.toContain('--commit');
  });

  // --- GitLab platform: success ---
  test('gitlab_success — glab pipeline completes with success', async () => {
    execRegistry['git remote get-url origin'] = 'https://gitlab.com/org/repo.git';
    execRegistry['glab ci list'] = [
      JSON.stringify([glabPipeline({ status: 'running' })]),
      JSON.stringify([glabPipeline({ status: 'success' })]),
    ];

    const result = await ciWaitRunHandler.execute({ ref: 'main' });
    const data = parseResult(result.content);
    expect(data.ok).toBe(true);
    expect(data.final_status).toBe('success');
    expect(data.run_id).toBe(999);
  });

  // --- GitLab platform: failure ---
  test('gitlab_failure — glab pipeline status=failed maps to failure', async () => {
    execRegistry['git remote get-url origin'] = 'https://gitlab.com/org/repo.git';
    execRegistry['glab ci list'] = JSON.stringify([
      glabPipeline({ status: 'failed' }),
    ]);

    const result = await ciWaitRunHandler.execute({ ref: 'main' });
    const data = parseResult(result.content);
    expect(data.ok).toBe(true);
    expect(data.final_status).toBe('failure');
  });

  // --- GitLab platform: canceled (American spelling from glab) ---
  test('gitlab_canceled — glab pipeline status=canceled maps to cancelled', async () => {
    execRegistry['git remote get-url origin'] = 'https://gitlab.com/org/repo.git';
    execRegistry['glab ci list'] = JSON.stringify([
      glabPipeline({ status: 'canceled' }),
    ]);

    const result = await ciWaitRunHandler.execute({ ref: 'main' });
    const data = parseResult(result.content);
    expect(data.ok).toBe(true);
    expect(data.final_status).toBe('cancelled');
  });

  // --- gh command failure surfaces a helpful error ---
  test('gh_error — gh run list failure returns an informative error', async () => {
    execRegistry['git remote get-url origin'] = 'https://github.com/org/repo.git';
    // Throw from the mocked exec by making the registry entry mean "unexpected" for gh.
    // We achieve that by simply not registering the gh run list key.
    const result = await ciWaitRunHandler.execute({ ref: 'main' });
    const data = parseResult(result.content);
    expect(data.ok).toBe(false);
    // The error should mention gh run list or ref.
    expect((data.error as string).length).toBeGreaterThan(0);
  });

  // --- unknown conclusion surfaces a clear error ---
  test('unknown_conclusion — unrecognized conclusion returns error with run metadata', async () => {
    execRegistry['git remote get-url origin'] = 'https://github.com/org/repo.git';
    execRegistry['gh run list'] = JSON.stringify([
      ghRun({ status: 'completed', conclusion: 'mystery_status' }),
    ]);

    const result = await ciWaitRunHandler.execute({ ref: 'main' });
    const data = parseResult(result.content);
    expect(data.ok).toBe(false);
    expect((data.error as string)).toContain('mystery_status');
    expect(data.run_id).toBe(12345);
  });

  // --- reset sleep fn helper is exported ---
  test('sleep_helpers_exported — __setSleep and __resetSleep are exported', () => {
    expect(typeof __setSleep).toBe('function');
    expect(typeof __resetSleep).toBe('function');
    __resetSleep();
    // Re-set no-op for subsequent tests in this describe block.
    __setSleep(async (_ms: number) => {
      // no-op
    });
  });
});
