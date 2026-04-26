import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { AdapterResult, PrMergeWaitResponse } from './types.ts';

// Subprocess-boundary tests for the GitHub pr_merge_wait adapter (R-15).
// Lifted from tests/pr_merge_wait.test.ts during Story 1.11 (#248). The
// adapter orchestrates: detect-and-skip via fetchPrState, dispatch to
// prMerge, and poll-until-merged on the queue path. Subprocess interception
// happens via mock.module('child_process', ...) — every test installs its OWN
// mock BEFORE the dynamic import (56-file convention; see
// `.claude/projects/.../memory/MEMORY.md` "Bun mock.module pollution").

interface ThrowableError extends Error {
  stderr?: string;
  stdout?: string;
  status?: number;
}

type Responder = string | (() => string);

let execRegistry: Array<{ match: string; respond: Responder }> = [];
let execCalls: string[] = [];

function unquote(cmd: string): string {
  return cmd.replace(/'([^']*)'/g, '$1');
}

const mockExecSync = mock((cmd: string, _opts?: unknown) => {
  execCalls.push(cmd);
  const flat = unquote(cmd);
  for (const { match, respond } of execRegistry) {
    if (cmd.includes(match) || flat.includes(match)) {
      return typeof respond === 'function' ? respond() : respond;
    }
  }
  const err = new Error(`Unexpected exec: ${cmd}`) as ThrowableError;
  err.stderr = `Unexpected exec: ${cmd}`;
  err.status = 127;
  throw err;
});

mock.module('child_process', () => ({ execSync: mockExecSync }));

const { executeMergeWaitForTest } = await import('./pr-merge-wait-github.ts');
const { clearMergeQueueCache } = await import('../merge_queue_detect.ts');

function on(match: string, respond: Responder) {
  execRegistry.push({ match, respond });
}

function stubNoQueue() {
  on(
    'gh api graphql',
    JSON.stringify({ data: { repository: { mergeQueue: null } } }),
  );
}

function stubEnforcedQueue() {
  on(
    'gh api graphql',
    JSON.stringify({ data: { repository: { mergeQueue: { __typename: 'MergeQueue' } } } }),
  );
}

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
  execRegistry = [];
  execCalls = [];
  clearMergeQueueCache();
  // Default cwd remote — GitHub origin so detectPlatform() picks github.
  on('git remote get-url origin', 'https://github.com/org/repo.git\n');
});

afterEach(() => {
  execRegistry = [];
  execCalls = [];
  clearMergeQueueCache();
});

describe('prMergeWaitGithub — adapter orchestration', () => {
  test('detect-and-skip: PR already merged → no merge call, warning emitted', async () => {
    on(
      'gh pr view 50 --json state,url,mergeCommit',
      JSON.stringify({
        state: 'MERGED',
        url: 'https://github.com/org/repo/pull/50',
        mergeCommit: { oid: 'preexisting' },
      }),
    );

    const result = await executeMergeWaitForTest(
      { number: 50 },
      { now: () => 0, sleep: async () => {}, intervalMs: 10000 },
    );

    expectOk(result);
    expect(result.data.merged).toBe(true);
    expect(result.data.pr_state).toBe('MERGED');
    expect(result.data.merge_commit_sha).toBe('preexisting');
    expect(result.data.warnings.length).toBe(1);
    expect(result.data.warnings[0]).toContain('already merged');
    expect(execCalls.find((c) => c.includes('gh pr merge'))).toBeUndefined();
  });

  test('direct merge path → returns synchronously, no polling', async () => {
    stubNoQueue();
    let viewCalls = 0;
    on('gh pr view 51 --json state,url,mergeCommit', () => {
      viewCalls += 1;
      const merged = viewCalls >= 2;
      return JSON.stringify({
        state: merged ? 'MERGED' : 'OPEN',
        url: 'https://github.com/org/repo/pull/51',
        mergeCommit: merged ? { oid: 'direct51' } : null,
      });
    });
    on('gh pr merge 51 --squash --delete-branch', '');

    const clock = fakeClock();
    const result = await executeMergeWaitForTest(
      { number: 51 },
      { now: clock.now, sleep: clock.sleep, intervalMs: 1 },
    );

    expectOk(result);
    expect(result.data.merged).toBe(true);
    expect(result.data.merge_method).toBe('direct_squash');
    expect(result.data.merge_commit_sha).toBe('direct51');
    expect(clock.sleepCount()).toBe(0);
  });

  // Regression #258 Bug 2: pr_merge_wait must NOT trust pr_merge's merged:true
  // when the underlying gh pr merge actually only enrolled. Pre-fix the handler
  // short-circuited at the direct path and reported merged:true; post-fix
  // pr_merge reports merged:false and pr_merge_wait polls until landing.
  test('regression #258: direct path returns merged:false → polls until landing', async () => {
    stubNoQueue();
    let viewCallCount = 0;
    on('gh pr view 257 --json state,url,mergeCommit', () => {
      viewCallCount += 1;
      if (viewCallCount >= 5) {
        return JSON.stringify({
          state: 'MERGED',
          url: 'https://github.com/org/repo/pull/257',
          mergeCommit: { oid: 'eventually-merged' },
        });
      }
      return JSON.stringify({
        state: 'OPEN',
        url: 'https://github.com/org/repo/pull/257',
        mergeCommit: null,
      });
    });
    on('gh pr merge 257 --squash --delete-branch', '');

    const clock = fakeClock();
    const result = await executeMergeWaitForTest(
      { number: 257 },
      { now: clock.now, sleep: clock.sleep, intervalMs: 1000 },
    );

    expectOk(result);
    expect(result.data.merged).toBe(true);
    expect(result.data.pr_state).toBe('MERGED');
    expect(result.data.merge_commit_sha).toBe('eventually-merged');
    expect(clock.sleepCount()).toBeGreaterThan(0);
  });

  test('queue path → polls until state flips to merged', async () => {
    stubEnforcedQueue();
    let viewCallCount = 0;
    on('gh pr view 60 --json state,url,mergeCommit', () => {
      viewCallCount += 1;
      if (viewCallCount >= 5) {
        return JSON.stringify({
          state: 'MERGED',
          url: 'https://github.com/org/repo/pull/60',
          mergeCommit: { oid: 'queued-sha' },
        });
      }
      return JSON.stringify({
        state: 'OPEN',
        url: 'https://github.com/org/repo/pull/60',
        mergeCommit: null,
      });
    });
    on('gh pr merge 60 --squash --delete-branch --auto', '');

    const clock = fakeClock();
    const result = await executeMergeWaitForTest(
      { number: 60 },
      { now: clock.now, sleep: clock.sleep, intervalMs: 1000 },
    );

    expectOk(result);
    expect(result.data.merged).toBe(true);
    expect(result.data.pr_state).toBe('MERGED');
    expect(result.data.merge_method).toBe('merge_queue');
    expect(result.data.merge_commit_sha).toBe('queued-sha');
    expect(clock.sleepCount()).toBeGreaterThan(0);
  });

  test('queue path → timeout returns ok:false with descriptive error', async () => {
    stubEnforcedQueue();
    on(
      'gh pr view 70 --json state,url,mergeCommit',
      JSON.stringify({
        state: 'OPEN',
        url: 'https://github.com/org/repo/pull/70',
        mergeCommit: null,
      }),
    );
    on('gh pr merge 70 --squash --delete-branch --auto', '');

    const clock = fakeClock();
    const result = await executeMergeWaitForTest(
      { number: 70, timeout_sec: 30 },
      { now: clock.now, sleep: clock.sleep, intervalMs: 10000 },
    );

    expectErr(result);
    expect(result.error).toContain('timed out after 30s');
    expect(result.error).toContain('PR #70');
    expect(result.error).toContain('queue.enforced: true');
  });

  test('queue path → fetch_error mid-poll surfaces "after enrollment" context', async () => {
    stubEnforcedQueue();
    let viewCallCount = 0;
    on('gh pr view 71 --json state,url,mergeCommit', () => {
      viewCallCount += 1;
      if (viewCallCount >= 4) {
        throw new Error('gh: API rate limit exceeded');
      }
      return JSON.stringify({
        state: 'OPEN',
        url: 'https://github.com/org/repo/pull/71',
        mergeCommit: null,
      });
    });
    on('gh pr merge 71 --squash --delete-branch --auto', '');

    const clock = fakeClock();
    const result = await executeMergeWaitForTest(
      { number: 71 },
      { now: clock.now, sleep: clock.sleep, intervalMs: 1000 },
    );

    expectErr(result);
    expect(result.error).toContain('after enrollment');
    expect(result.error).toContain('PR #71');
    expect(result.error).toContain('rate limit');
    expect(result.error).toContain('queue.enforced: true');
  });

  test('pr_merge failure propagates unchanged', async () => {
    stubNoQueue();
    on(
      'gh pr view 80 --json state,url,mergeCommit',
      JSON.stringify({
        state: 'OPEN',
        url: 'https://github.com/org/repo/pull/80',
        mergeCommit: null,
      }),
    );
    on('gh pr merge 80 --squash --delete-branch', () => {
      const err = new Error('Pull request is not mergeable: conflicts') as ThrowableError;
      err.stderr = 'Pull request is not mergeable: conflicts\n';
      throw err;
    });

    const result = await executeMergeWaitForTest(
      { number: 80 },
      { now: () => 0, sleep: async () => {}, intervalMs: 1 },
    );

    expectErr(result);
    expect(result.error).toContain('gh pr merge failed');
  });

  test('initial state-fetch failure surfaces a clear error', async () => {
    on('gh pr view 90 --json state,url,mergeCommit', () => {
      throw new Error('PR not found');
    });

    const result = await executeMergeWaitForTest(
      { number: 90 },
      { now: () => 0, sleep: async () => {}, intervalMs: 1 },
    );

    expectErr(result);
    expect(result.error).toContain('failed to read initial PR state');
    expect(result.error).toContain('PR not found');
  });
});
