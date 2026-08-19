import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  installChildProcessMock,
  onExec,
  resetExecMock,
  execCalls,
} from '../test-support/mock-child-process.ts';
import type { AdapterResult, PrMergeWaitResponse } from './types.ts';

// Cross-platform parity tests for the GitLab pr_merge_wait adapter (Story 1.11).
// Mirrors the GitHub adapter scenarios — same orchestration, glab subprocess
// shapes instead of gh. The orchestration helper (`executeMergeWait`) is
// platform-free; routing happens via getAdapter() driven by the cwd remote.
//
// Each test file installs its OWN mock.module BEFORE the dynamic import
// (56-file convention).

interface ThrowableError extends Error {
  stderr?: string;
  stdout?: string;
  status?: number;
}

installChildProcessMock();

const { prMergeWaitGitlab } = await import('./pr-merge-wait-gitlab.ts');
const { executeMergeWaitForTest } = await import('./pr-merge-wait-github.ts');

function fakeClock(startMs: number = 0) {
  let nowMs = startMs;
  let sleepCount = 0;
  return {
    now: () => nowMs,
    sleep: async (ms: number) => {
      nowMs += ms;
      sleepCount += 1;
    },
    sleepCount: () => sleepCount,
  };
}

function expectOk(
  r: AdapterResult<PrMergeWaitResponse>,
): asserts r is { ok: true; data: PrMergeWaitResponse } {
  if (!('ok' in r) || !r.ok) {
    throw new Error(`expected ok result, got ${JSON.stringify(r)}`);
  }
}

function expectErr(
  r: AdapterResult<PrMergeWaitResponse>,
): asserts r is { ok: false; error: string; code: string } {
  if (!('ok' in r) || r.ok) {
    throw new Error(`expected error result, got ${JSON.stringify(r)}`);
  }
}

beforeEach(() => {
  resetExecMock();
  // GitLab origin so detectPlatform() routes to gitlabAdapter.
  onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git\n');
});

afterEach(() => {
  resetExecMock();
});

describe('prMergeWaitGitlab — adapter orchestration (parity)', () => {
  test('detect-and-skip: MR already merged → no merge call', async () => {
    onExec(
      'glab api projects/org%2Frepo/merge_requests/50',
      JSON.stringify({
        iid: 50,
        state: 'merged',
        source_branch: 'feature/x',
        target_branch: 'main',
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/50',
        labels: [],
        sha: 'waithead01',
        merge_commit_sha: 'preexisting',
      }),
    );

    const result = await prMergeWaitGitlab({ number: 50, repo: 'org/repo' });

    expectOk(result);
    expect(result.data.merged).toBe(true);
    expect(result.data.pr_state).toBe('MERGED');
    expect(result.data.merge_commit_sha).toBe('preexisting');
    expect(result.data.warnings.length).toBe(1);
    expect(result.data.warnings[0]).toContain('already merged');
    expect(execCalls().find((c) => c.includes('glab mr merge'))).toBeUndefined();
  });

  test('direct merge path → returns synchronously, no polling', async () => {
    let viewCalls = 0;
    onExec('glab api projects/org%2Frepo/merge_requests/51', () => {
      viewCalls += 1;
      const merged = viewCalls >= 2;
      return JSON.stringify({
        iid: 51,
        state: merged ? 'merged' : 'opened',
        source_branch: 'feature/x',
        target_branch: 'main',
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/51',
        labels: [],
        sha: 'waithead02',
        merge_commit_sha: merged ? 'direct51' : null,
      });
    });
    onExec('glab mr merge 51 --squash --remove-source-branch --yes', '');

    const clock = fakeClock();
    const result = await executeMergeWaitForTest(
      { number: 51, repo: 'org/repo' },
      { now: clock.now, sleep: clock.sleep, intervalMs: 1 },
    );

    expectOk(result);
    expect(result.data.merged).toBe(true);
    expect(result.data.merge_method).toBe('direct_squash');
    expect(result.data.merge_commit_sha).toBe('direct51');
    expect(clock.sleepCount()).toBe(0);
  });

  test('skip_train is silently dropped — merge proceeds with warning (#423)', async () => {
    let viewCalls = 0;
    onExec('glab api projects/org%2Frepo/merge_requests/55', () => {
      viewCalls += 1;
      const merged = viewCalls >= 2;
      return JSON.stringify({
        iid: 55,
        state: merged ? 'merged' : 'opened',
        source_branch: 'feature/x',
        target_branch: 'main',
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/55',
        labels: [],
        sha: 'waithead03',
        merge_commit_sha: merged ? 'skip55abc' : null,
      });
    });
    onExec('glab mr merge 55 --squash --remove-source-branch --yes', '');

    const result = await prMergeWaitGitlab({
      number: 55,
      repo: 'org/repo',
      skip_train: true,
    });

    expectOk(result);
    expect(result.data.merged).toBe(true);
    expect(result.data.warnings).toContain(
      'skip_train ignored on GitLab — merge trains are auto-managed at the project level',
    );
  });

  test('pr_merge failure propagates unchanged', async () => {
    onExec(
      'glab api projects/org%2Frepo/merge_requests/80',
      JSON.stringify({
        iid: 80,
        state: 'opened',
        source_branch: 'feature/x',
        target_branch: 'main',
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/80',
        labels: [],
        sha: 'waithead04',
      }),
    );
    onExec('glab mr merge 80 --squash --remove-source-branch --yes', () => {
      const err = new Error('!! conflicts') as ThrowableError;
      err.stderr = 'cannot merge\n';
      throw err;
    });

    const result = await executeMergeWaitForTest(
      { number: 80, repo: 'org/repo' },
      { now: () => 0, sleep: async () => {}, intervalMs: 1 },
    );

    expectErr(result);
    expect(result.error).toContain('glab mr merge failed');
  });

  test('initial state-fetch failure surfaces a clear error', async () => {
    onExec('glab api projects/org%2Frepo/merge_requests/90', () => {
      throw new Error('MR not found');
    });

    const result = await prMergeWaitGitlab({ number: 90, repo: 'org/repo' });

    expectErr(result);
    expect(result.error).toContain('failed to read initial PR state');
  });

  // =========================================================================
  // #488 — pipeline-gated GitLab MR enrolls instead of failing outright
  // =========================================================================
  //
  // Before #488: prMergeGitlab always forced --auto-merge=false (#486), so a
  // pipeline-gated MR made glab REFUSE rather than enroll — prMerge returned
  // ok:false and executeMergeWait short-circuited to pr_merge_failed without
  // ever polling.
  //
  // executeMergeWait now sets allow_gitlab_enrollment:true, but (per code
  // review) prMergeGitlab always attempts --auto-merge=false FIRST — enrolling
  // unconditionally would change behavior for MRs that don't need it at all.
  // So the realistic sequence is: deterministic attempt refused (glab's own
  // client-side gate rejects because the pipeline hasn't passed), retried with
  // --auto-merge=true (which enrolls), THEN this wait polls past the
  // still-pending pipeline to the real merge — exactly like the GitHub queue
  // path.

  // =========================================================================
  // #518 — a NON-pipeline block (approvals, discussions, draft, conflicts)
  // makes prMergeGitlab return ok:true, merged:false, enrolled:false with the
  // reason in warnings (#461/#520). executeMergeWait must fail FAST with that
  // reason instead of polling the dead MR for the full timeout — and never
  // enter the poll loop where an out-of-band merge could spread a stale block
  // warning onto a merged:true envelope.
  // =========================================================================
  test('#518 — blocked MR (enrolled:false) fails fast, names the block, does not poll', async () => {
    // The narrow-but-real shape #520 surfaces: the deterministic
    // --auto-merge=false attempt EXITS 0, yet the post-merge read classifies
    // the MR as blocked — a block glab did not reject client-side (e.g. an
    // external `blocked_status`), or the #424 read-after-write window. That
    // makes prMergeGitlab report ok:true, merged:false, enrolled:false with the
    // reason in warnings — the shape this guard must fail fast on.
    //
    // Contrast the sibling adapter test (pr-merge-gitlab.test.ts, "not_approved
    // is not transient"): a block glab DOES catch client-side (not_approved)
    // makes `glab mr merge` throw 405, so prMergeGitlab returns ok:false and
    // executeMergeWait already reports pr_merge_failed BEFORE this guard. That
    // path is not what #518 fixes, so this test must not model it.
    //
    // `blocked_status` classifies as a genuine block (not `ci_must_pass`, the
    // one status the enrollment carve-out spares), so enrollment is NOT retried
    // and the adapter reports enrolled:false. One body serves all three reads:
    // fetchPrState (detect-and-skip), resolveHeadSha, and pollPostMergeState.
    onExec(
      'glab api projects/org%2Frepo/merge_requests/85',
      JSON.stringify({
        iid: 85,
        state: 'opened',
        detailed_merge_status: 'blocked_status',
        source_branch: 'feature/x',
        target_branch: 'main',
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/85',
        labels: [],
        sha: 'blockhead01',
      }),
    );
    // Deterministic --auto-merge=false attempt exits 0; the MR then reads back
    // opened + blocked_status → prMergeGitlab reports enrolled:false.
    onExec('glab mr merge 85 --squash --remove-source-branch --yes', '');

    const clock = fakeClock();
    const result = await executeMergeWaitForTest(
      { number: 85, repo: 'org/repo' },
      { now: clock.now, sleep: clock.sleep, intervalMs: 1 },
    );

    expectErr(result);
    expect(result.code).toBe('pr_merge_blocked');
    expect(result.error).toContain('blocked_status');
    expect(result.error).toContain('PR #85');
    // The tell that no full-timeout poll happened: executeMergeWait's own poll
    // loop never slept.
    expect(clock.sleepCount()).toBe(0);
  });

  test('pipeline-gated MR: deterministic attempt refused, retries and enrolls, then polls to merged', async () => {
    let mergeAttempts = 0;
    onExec('glab mr merge 65 --squash --remove-source-branch --yes', (cmd) => {
      mergeAttempts += 1;
      if (cmd.includes('--auto-merge=false')) {
        const err = new Error('405 Method Not Allowed') as ThrowableError;
        err.stderr = '405 Method Not Allowed — pipeline has not succeeded\n';
        throw err;
      }
      return ''; // --auto-merge=true retry succeeds (enrolls)
    });
    let apiCallCount = 0;
    // Stays 'opened'/ci_must_pass for a while (long enough to exhaust
    // pollPostMergeState's internal budget inside prMergeGitlab AND for
    // pollUntilMerged's own first checks), then settles to merged — a
    // pipeline that takes a few polls to finish.
    onExec('glab api projects/org%2Frepo/merge_requests/65', () => {
      apiCallCount += 1;
      const merged = apiCallCount >= 9;
      return JSON.stringify({
        iid: 65,
        state: merged ? 'merged' : 'opened',
        detailed_merge_status: merged ? 'mergeable' : 'ci_must_pass',
        source_branch: 'feature/x',
        target_branch: 'main',
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/65',
        labels: [],
        sha: 'waithead05',
        merge_commit_sha: merged ? 'enrolled65' : null,
      });
    });

    const clock = fakeClock();
    const result = await executeMergeWaitForTest(
      { number: 65, repo: 'org/repo' },
      { now: clock.now, sleep: clock.sleep, intervalMs: 1 },
    );

    expectOk(result);
    expect(result.data.merged).toBe(true);
    expect(result.data.merge_commit_sha).toBe('enrolled65');
    expect(result.data.pr_state).toBe('MERGED');
    // Confirms the retry actually happened — this reached the poll rather
    // than short-circuiting to pr_merge_failed on the first refusal, which
    // #488 exists to fix.
    expect(mergeAttempts).toBe(2);
    const attemptCalls = execCalls().filter((c) => c.startsWith('glab mr merge 65'));
    expect(attemptCalls[0]).toContain('--auto-merge=false');
    expect(attemptCalls[1]).toContain('--auto-merge=true');
  }, 10000);
});
