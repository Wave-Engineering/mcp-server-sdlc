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

// The MR's current head. A fixture pipeline on this sha is bound to it (#588).
const HEAD = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';

function mrJson(status: string | undefined, web_url: string = 'https://gitlab.com/org/repo/-/merge_requests/3') {
  const obj: Record<string, unknown> = {
    iid: 3,
    state: 'opened',
    web_url,
    sha: HEAD,
  };
  if (status !== undefined) obj.head_pipeline = { id: 11, status, sha: HEAD, ref: 'feature/x' };
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
      graded: { id: 11, sha: HEAD, ref: 'feature/x' },
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
        sha: HEAD,
        head_pipeline: { id: 11, status: 'success', sha: HEAD, ref: 'feature/x' },
        pipeline: { id: 12, status: 'failed', sha: HEAD, ref: 'feature/x' },
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
  test('empty pipeline no longer certifies "no CI" — GitLab creates pipelines async (#508)', async () => {
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
      poll_interval_sec: 5,
      timeout_sec: 1800,
      // #508 knob — zero keeps this a fast unit test; the settle loop itself is
      // covered with a fake clock below.
      settle_window_sec: 0,
    });
    if (!('ok' in result) || !result.ok) {
      throw new Error(`expected ok result, got ${JSON.stringify(result)}`);
    }
    const data = result.data as { status?: string; mergeable?: boolean; blocker?: string; elapsed_sec?: number };
    // `head_pipeline: null` on GitLab is ALSO "the pipeline has not been created
    // yet" — GitLab creates it asynchronously after the MR. The ref cross-check
    // cannot run under this mock, so nothing may certify "no CI configured".
    expect(data.status).toBe('no_checks_yet');
    expect(data.mergeable).toBe(false);
    expect(data.blocker).toBe('evidence_unavailable');
  });

  test('a QUEUED pipeline for the head SHA → no_checks_yet, never mergeable (#508)', async () => {
    const clock = (() => {
      let t = 1_000_000;
      return { now: () => t, sleep: async (ms: number) => { t += ms; } };
    })();
    const result = await prWaitCiGitlab(
      { number: 3, poll_interval_sec: 5, timeout_sec: 1800 },
      {
        probe: () => ({
          iid: 3,
          state: 'opened',
          title: 't',
          description: null,
          source_branch: 'f',
          target_branch: 'main',
          web_url: 'https://gitlab.com/org/repo/-/merge_requests/3',
          labels: [],
          draft: false,
          has_conflicts: false,
          merge_status: 'can_be_merged',
          detailed_merge_status: 'mergeable',
          diff_refs: { head_sha: 'deadbeef' },
        }),
        pendingRuns: async () => ({
          ok: true,
          runs: [{ run_id: 7, workflow_name: 'pipeline', status: 'pending' }],
        }),
        now: clock.now,
        sleep: clock.sleep,
        settleWindowSec: 45,
        settlePollSec: 5,
      },
    );
    if (!('ok' in result) || !result.ok) throw new Error('expected ok');
    const data = result.data as { status?: string; mergeable?: boolean; blocker?: string; elapsed_sec?: number };
    expect(data.status).toBe('no_checks_yet');
    expect(data.mergeable).toBe(false);
    expect(data.blocker).toBe('checks_not_registered');
    expect(data.elapsed_sec).toBeGreaterThan(0);
  });

  test('empty pipeline + draft MR → no_checks_configured + draft blocker', async () => {
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
    expect(data.status).toBe('no_checks_configured');
    expect(data.mergeable).toBe(false);
    expect(data.blocker).toBe('draft');
  });

  test('empty pipeline + conflicts → no_checks_configured + conflicts blocker', async () => {
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
    expect(data.status).toBe('no_checks_configured');
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

// #588: right after a push, GitLab can leave `head_pipeline` on the PREVIOUS
// head's pipeline — already terminal — for a few seconds. Grading it passed the
// merge gate on a commit CI never saw.
describe('#588 — only a pipeline bound to the current head is graded', () => {
  const OLD = 'b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0';
  const NEW = 'c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1';
  const BASE = 'd2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2';
  const MERGE_OLD = 'e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3';
  const MERGE_NEW = 'f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4';
  const MERGE_REF = 'refs/merge-requests/3/merge';
  const PARENTS: Record<string, string[]> = {
    [MERGE_OLD]: [BASE, OLD],
    [MERGE_NEW]: [BASE, NEW],
  };
  const parentsOf = (sha: string) => PARENTS[sha];

  function mr(head: string, pipeline: Record<string, unknown> | null) {
    return JSON.stringify({
      iid: 3,
      state: 'opened',
      web_url: 'https://gitlab.com/org/repo/-/merge_requests/3',
      sha: head,
      ...(pipeline !== null ? { head_pipeline: pipeline } : {}),
    });
  }

  /** The MR fetch returns each fixture in turn, then repeats the last. */
  function mrSequence(...bodies: string[]) {
    let i = 0;
    onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    onExec('glab api projects/org%2Frepo/merge_requests/3', () => bodies[Math.min(i++, bodies.length - 1)]);
  }

  /** Drive the real poll loop over snapshotGitlab with a fake clock. */
  async function poll(timeoutSec = 600) {
    const { runPollLoop } = await import('../pr-wait-ci-poll.ts');
    let t = 0;
    return runPollLoop(
      { number: 3, poll_interval_sec: 5, timeout_sec: timeoutSec },
      {
        snapshotFn: (n, repo) => snapshotGitlab(n, repo, parentsOf),
        sleepFn: async (ms) => {
          t += ms;
        },
        nowFn: () => t,
      },
    );
  }

  test("RED: a terminal pipeline for the PREVIOUS head reads as pending, not passed", () => {
    mrSequence(mr(NEW, { id: 10, status: 'success', sha: OLD, ref: 'feature/x' }));
    const snap = snapshotGitlab(3, undefined, parentsOf);
    expect(snap.pending).toBe(1);
    expect(snap.passed).toBe(0);
    expect(snap.graded).toBeUndefined();
    expect(snap.summary).toContain('head_pipeline 10');
    expect(snap.summary).toContain('not attached yet');
  });

  test('push then an immediate wait: holds past the old pass, grades the new head pipeline', async () => {
    mrSequence(
      mr(NEW, { id: 10, status: 'success', sha: OLD, ref: 'feature/x' }),
      mr(NEW, { id: 10, status: 'success', sha: OLD, ref: 'feature/x' }),
      mr(NEW, { id: 20, status: 'running', sha: NEW, ref: 'feature/x' }),
      mr(NEW, { id: 20, status: 'failed', sha: NEW, ref: 'feature/x' }),
    );
    const r = await poll();
    // The old head's green pipeline must not decide the wait; the new one does.
    expect(r.final_state).toBe('failed');
    expect(r.graded_pipeline).toEqual({ id: 20, sha: NEW, ref: 'feature/x' });
    expect(r.waited_sec).toBe(15);
  });

  test('a head pipeline that never attaches times out, never passes', async () => {
    mrSequence(mr(NEW, { id: 10, status: 'success', sha: OLD, ref: 'feature/x' }));
    const r = await poll(30);
    expect(r.final_state).toBe('timed_out');
    expect(r.graded_pipeline).toBeUndefined();
  });

  test('merged-results: the PREVIOUS head merge pipeline reads as pending', () => {
    mrSequence(mr(NEW, { id: 10, status: 'success', sha: MERGE_OLD, ref: MERGE_REF }));
    const snap = snapshotGitlab(3, undefined, parentsOf);
    expect(snap.pending).toBe(1);
    expect(snap.passed).toBe(0);
  });

  test('merged-results: push then wait grades the merge pipeline whose 2nd parent is the head', async () => {
    mrSequence(
      mr(NEW, { id: 10, status: 'success', sha: MERGE_OLD, ref: MERGE_REF }),
      mr(NEW, { id: 21, status: 'success', sha: MERGE_NEW, ref: MERGE_REF }),
    );
    const r = await poll();
    expect(r.final_state).toBe('passed');
    expect(r.graded_pipeline).toEqual({ id: 21, sha: MERGE_NEW, ref: MERGE_REF });
    expect(r.waited_sec).toBe(5);
  });

  test('merged-results: the head as FIRST parent does not bind', () => {
    mrSequence(mr(NEW, { id: 21, status: 'success', sha: MERGE_NEW, ref: MERGE_REF }));
    const snap = snapshotGitlab(3, undefined, () => [NEW, BASE]);
    expect(snap.pending).toBe(1);
  });

  test('merged-results: a failed merge-commit lookup reads as pending', () => {
    mrSequence(mr(NEW, { id: 21, status: 'success', sha: MERGE_NEW, ref: MERGE_REF }));
    const snap = snapshotGitlab(3, undefined, () => undefined);
    expect(snap.pending).toBe(1);
    expect(snap.summary).toContain('could not read merge commit');
  });

  test('a non-merge ref is never bound by parents (e.g. a merge train)', () => {
    mrSequence(mr(NEW, { id: 22, status: 'success', sha: MERGE_NEW, ref: 'refs/merge-requests/3/train' }));
    const snap = snapshotGitlab(3, undefined, parentsOf);
    expect(snap.pending).toBe(1);
  });

  test('no head SHA on the MR fails closed: pending, never passed', () => {
    onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    onExec(
      'glab api projects/org%2Frepo/merge_requests/3',
      JSON.stringify({ iid: 3, state: 'opened', web_url: 'u', head_pipeline: { id: 10, status: 'success', sha: OLD, ref: 'f' } }),
    );
    const snap = snapshotGitlab(3, undefined, parentsOf);
    expect(snap.pending).toBe(1);
    expect(snap.summary).toContain('no head SHA');
  });

  test('diff_refs.head_sha wins over the top-level sha', () => {
    onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    onExec(
      'glab api projects/org%2Frepo/merge_requests/3',
      JSON.stringify({
        iid: 3,
        state: 'opened',
        web_url: 'u',
        sha: OLD,
        diff_refs: { head_sha: NEW },
        head_pipeline: { id: 10, status: 'success', sha: OLD, ref: 'f' },
      }),
    );
    expect(snapshotGitlab(3, undefined, parentsOf).pending).toBe(1);
  });

  test('GREEN: a head pipeline already finished returns at once (no regression)', async () => {
    mrSequence(mr(NEW, { id: 20, status: 'success', sha: NEW, ref: 'feature/x' }));
    const r = await poll();
    expect(r.final_state).toBe('passed');
    expect(r.waited_sec).toBe(0);
    expect(r.graded_pipeline).toEqual({ id: 20, sha: NEW, ref: 'feature/x' });
  });

  test('apiParentsOf reads each merge commit once per wait', async () => {
    const { apiParentsOf } = await import('../gitlab-head-pipeline.ts');
    onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    onExec(
      'glab api projects/org%2Frepo/repository/commits/' + MERGE_NEW,
      JSON.stringify({ id: MERGE_NEW, parent_ids: [BASE, NEW] }),
    );
    const lookup = apiParentsOf();
    expect(lookup(MERGE_NEW)).toEqual([BASE, NEW]);
    expect(lookup(MERGE_NEW)).toEqual([BASE, NEW]);
    expect(execCalls().filter((c) => c.includes('repository/commits/')).length).toBe(1);
  });
});
