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
});
