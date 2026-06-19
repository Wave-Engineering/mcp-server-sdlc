import { describe, test, expect, beforeEach } from 'bun:test';
import {
  installChildProcessMock,
  onExec,
  resetExecMock,
  execCalls,
} from '../test-support/mock-child-process.ts';

// Subprocess-boundary tests for the GitLab pr_wait_ci adapter (R-15).
// Locks the pipeline-status normalization table (success/failed/canceled/...
// → passed/failed/pending), the API URL shape, and the cross-repo slug routing.

interface ThrowableError extends Error {
  stderr?: string;
  stdout?: string;
  status?: number;
}

installChildProcessMock();

const { prWaitCiGitlab, snapshotGitlab } = await import('./pr-wait-ci-gitlab.ts');

beforeEach(() => {
  resetExecMock();
});

function mrJson(status: string | undefined, web_url: string = 'https://gitlab.com/org/repo/-/merge_requests/3') {
  const obj: Record<string, unknown> = {
    iid: 3,
    state: 'opened',
    web_url,
  };
  if (status !== undefined) obj.head_pipeline = { status };
  return JSON.stringify(obj);
}

describe('snapshotGitlab — pipeline-status normalization table', () => {
  test('queries glab api projects/<encoded-slug>/merge_requests/<iid>', () => {
    onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    onExec('glab api projects/org%2Frepo/merge_requests/3', mrJson('success'));

    const snap = snapshotGitlab(3);
    expect(snap.passed).toBe(1);
    expect(snap.summary).toBe('pipeline success');

    const apiCall = execCalls().find((c) => c.includes('glab api projects/')) ?? '';
    expect(apiCall).toContain('org%2Frepo');
    expect(apiCall).toContain('merge_requests/3');
  });

  test('success → passed=1', () => {
    onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    onExec('glab api projects/org%2Frepo/merge_requests/3', mrJson('success'));
    const snap = snapshotGitlab(3);
    expect(snap).toEqual({
      total: 1,
      passed: 1,
      failed: 0,
      pending: 0,
      summary: 'pipeline success',
      url: 'https://gitlab.com/org/repo/-/merge_requests/3',
    });
  });

  test('failed/canceled/cancelled → failed=1', () => {
    for (const status of ['failed', 'canceled', 'cancelled']) {
      resetExecMock();
      onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git');
      onExec('glab api projects/org%2Frepo/merge_requests/3', mrJson(status));
      const snap = snapshotGitlab(3);
      expect(snap.failed).toBe(1);
      expect(snap.passed).toBe(0);
      expect(snap.pending).toBe(0);
      expect(snap.total).toBe(1);
    }
  });

  test('running/pending/created/preparing/waiting_for_resource/scheduled/manual → pending=1', () => {
    for (const status of [
      'running',
      'pending',
      'created',
      'preparing',
      'waiting_for_resource',
      'scheduled',
      'manual',
    ]) {
      resetExecMock();
      onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git');
      onExec('glab api projects/org%2Frepo/merge_requests/3', mrJson(status));
      const snap = snapshotGitlab(3);
      expect(snap.pending).toBe(1);
      expect(snap.passed).toBe(0);
      expect(snap.failed).toBe(0);
      expect(snap.total).toBe(1);
    }
  });

  test('unknown / missing pipeline → all zeros (loop will time out)', () => {
    onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    onExec('glab api projects/org%2Frepo/merge_requests/3', mrJson(undefined));
    const snap = snapshotGitlab(3);
    expect(snap.total).toBe(0);
    expect(snap.passed).toBe(0);
    expect(snap.failed).toBe(0);
    expect(snap.pending).toBe(0);
    expect(snap.summary).toBe('pipeline unknown');
  });

  test('pipeline preferred over head_pipeline when both present', () => {
    onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    onExec(
      'glab api projects/org%2Frepo/merge_requests/3',
      JSON.stringify({
        iid: 3,
        state: 'opened',
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/3',
        head_pipeline: { status: 'success' },
        pipeline: { status: 'failed' },
      }),
    );
    // Note: the migration preserves the pre-existing handler precedence —
    // `head_pipeline.status` wins when both are present (preserves prior
    // pr_wait_ci behavior; pr_status uses the opposite precedence).
    const snap = snapshotGitlab(3);
    expect(snap.passed).toBe(1);
    expect(snap.failed).toBe(0);
  });

  test('args.repo overrides cwd remote — slug is URL-encoded', () => {
    onExec('git remote get-url origin', 'https://gitlab.com/cwd-org/cwd-repo.git');
    onExec(
      'glab api projects/target-org%2Ftarget-repo/merge_requests/3',
      mrJson('success', 'https://gitlab.com/target-org/target-repo/-/merge_requests/3'),
    );

    const snap = snapshotGitlab(3, 'target-org/target-repo');
    expect(snap.passed).toBe(1);

    const apiCall = execCalls().find((c) => c.includes('glab api projects/')) ?? '';
    expect(apiCall).toContain('target-org%2Ftarget-repo');
    expect(apiCall).not.toContain('cwd-org%2Fcwd-repo');
  });

  test('throws on glab failure (handler/poll-loop layer maps to AdapterResult)', () => {
    resetExecMock();
    onExec('glab api', () => {
      const err = new Error('glab: not authenticated') as ThrowableError;
      err.stderr = 'glab: not authenticated';
      err.status = 1;
      throw err;
    });
    onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    expect(() => snapshotGitlab(3)).toThrow();
  });
});

describe('prWaitCiGitlab — full poll path', () => {
  test('successful pipeline → final_state passed on first iteration', async () => {
    onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    onExec('glab api projects/org%2Frepo/merge_requests/3', mrJson('success'));

    const result = await prWaitCiGitlab({
      number: 3,
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
    expect(result.data.url).toBe('https://gitlab.com/org/repo/-/merge_requests/3');
    expect(result.data.number).toBe(3);
  });

  test('failed pipeline → final_state failed', async () => {
    onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    onExec('glab api projects/org%2Frepo/merge_requests/9', mrJson('failed', 'https://gitlab.com/org/repo/-/merge_requests/9'));

    const result = await prWaitCiGitlab({
      number: 9,
      poll_interval_sec: 5,
      timeout_sec: 10,
    });
    if (!('ok' in result) || !result.ok) {
      throw new Error(`expected ok result, got ${JSON.stringify(result)}`);
    }
    if (!('final_state' in result.data)) {
      throw new Error(`expected polled-response shape, got ${JSON.stringify(result.data)}`);
    }
    expect(result.data.final_state).toBe('failed');
    expect(result.data.checks.failed).toBe(1);
  });

  // --- #416: empty-pipeline short-circuit ---
  test('empty pipeline + mergeable MR → no_checks_required immediately', async () => {
    onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    onExec(
      'glab api projects/org%2Frepo/merge_requests/3',
      JSON.stringify({
        iid: 3,
        state: 'opened',
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/3',
        // No head_pipeline / pipeline → empty pipeline.
        draft: false,
        has_conflicts: false,
        merge_status: 'can_be_merged',
        detailed_merge_status: 'mergeable',
      }),
    );

    const result = await prWaitCiGitlab({
      number: 3,
      // Generous timeout — proves we never enter the poll loop.
      poll_interval_sec: 5,
      timeout_sec: 1800,
    });
    if (!('ok' in result) || !result.ok) {
      throw new Error(`expected ok result, got ${JSON.stringify(result)}`);
    }
    const data = result.data as { status?: string; mergeable?: boolean; blocker?: string; elapsed_sec?: number };
    expect(data.status).toBe('no_checks_required');
    expect(data.mergeable).toBe(true);
    expect(data.blocker).toBeUndefined();
    expect(data.elapsed_sec).toBeLessThan(5);
  });

  test('empty pipeline + draft MR → no_checks_required + draft blocker', async () => {
    onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    onExec(
      'glab api projects/org%2Frepo/merge_requests/4',
      JSON.stringify({
        iid: 4,
        state: 'opened',
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/4',
        draft: true,
      }),
    );

    const result = await prWaitCiGitlab({
      number: 4,
      poll_interval_sec: 5,
      timeout_sec: 1800,
    });
    if (!('ok' in result) || !result.ok) {
      throw new Error(`expected ok result, got ${JSON.stringify(result)}`);
    }
    const data = result.data as { status?: string; mergeable?: boolean; blocker?: string };
    expect(data.status).toBe('no_checks_required');
    expect(data.mergeable).toBe(false);
    expect(data.blocker).toBe('draft');
  });

  test('empty pipeline + conflicts → no_checks_required + conflicts blocker', async () => {
    onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    onExec(
      'glab api projects/org%2Frepo/merge_requests/5',
      JSON.stringify({
        iid: 5,
        state: 'opened',
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/5',
        has_conflicts: true,
        merge_status: 'cannot_be_merged',
      }),
    );

    const result = await prWaitCiGitlab({
      number: 5,
      poll_interval_sec: 5,
      timeout_sec: 1800,
    });
    if (!('ok' in result) || !result.ok) {
      throw new Error(`expected ok result, got ${JSON.stringify(result)}`);
    }
    const data = result.data as { status?: string; mergeable?: boolean; blocker?: string };
    expect(data.status).toBe('no_checks_required');
    expect(data.mergeable).toBe(false);
    expect(data.blocker).toBe('conflicts');
  });

  test('non-empty pipeline (success) does NOT short-circuit — polled-response shape returned', async () => {
    // Regression — when head_pipeline is present we hit the poll path and the
    // returned envelope must carry `final_state`, NOT `status: no_checks_required`.
    onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    onExec('glab api projects/org%2Frepo/merge_requests/6', mrJson('success', 'https://gitlab.com/org/repo/-/merge_requests/6'));

    const result = await prWaitCiGitlab({
      number: 6,
      poll_interval_sec: 5,
      timeout_sec: 10,
    });
    if (!('ok' in result) || !result.ok) {
      throw new Error(`expected ok result, got ${JSON.stringify(result)}`);
    }
    const data = result.data as { status?: string; final_state?: string };
    expect(data.final_state).toBe('passed');
    expect(data.status).toBeUndefined();
  });

  test('glab failure → AdapterResult ok:false with unexpected_error code', async () => {
    onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    onExec('glab api projects/org%2Frepo/merge_requests/77', () => {
      const err = new Error('glab: not authenticated') as ThrowableError;
      err.stderr = 'glab: not authenticated';
      err.status = 1;
      throw err;
    });

    const result = await prWaitCiGitlab({
      number: 77,
      poll_interval_sec: 5,
      timeout_sec: 10,
    });
    if (!('ok' in result) || result.ok) {
      throw new Error(`expected error result, got ${JSON.stringify(result)}`);
    }
    expect(result.code).toBe('unexpected_error');
    expect(result.error).toContain('glab');
  });
});
