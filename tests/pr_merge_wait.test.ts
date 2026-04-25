import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';

interface ThrowableError extends Error {
  stderr?: string;
  stdout?: string;
  status?: number;
}

type Responder = string | (() => string);

let execRegistry: Array<{ match: string; respond: Responder }> = [];
let execCalls: string[] = [];

function mockExec(cmd: string): string {
  execCalls.push(cmd);
  for (const { match, respond } of execRegistry) {
    if (cmd.includes(match)) {
      return typeof respond === 'function' ? respond() : respond;
    }
  }
  throw new Error(`Unexpected exec call: ${cmd}`);
}

mock.module('child_process', () => ({
  execSync: (cmd: string, _opts?: unknown) => mockExec(cmd),
}));

const { default: prMergeWaitHandler, pollUntilMerged, executeWaitForTest } = await import(
  '../handlers/pr_merge_wait.ts'
);
const { clearMergeQueueCache } = await import('../lib/merge_queue_detect.ts');

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

function onExec(match: string, respond: Responder) {
  execRegistry.push({ match, respond });
}

function stubNoQueue() {
  onExec(
    'gh api graphql',
    JSON.stringify({ data: { repository: { mergeQueue: null } } }),
  );
}

function stubEnforcedQueue() {
  onExec(
    'gh api graphql',
    JSON.stringify({ data: { repository: { mergeQueue: { mergeMethod: 'SQUASH' } } } }),
  );
}

beforeEach(() => {
  execRegistry = [];
  execCalls = [];
  clearMergeQueueCache();
});

afterEach(() => {
  execRegistry = [];
  execCalls = [];
  clearMergeQueueCache();
});

// Fake clock + sleep for polling tests. Each sleep advances the clock by the
// requested interval so the timeout check fires at predictable virtual time.
function fakeClock(startMs: number = 0) {
  let nowMs = startMs;
  let sleepCount = 0;
  return {
    now: () => nowMs,
    sleep: async (ms: number) => {
      nowMs += ms;
      sleepCount += 1;
    },
    advance: (ms: number) => {
      nowMs += ms;
    },
    sleepCount: () => sleepCount,
  };
}

// ===========================================================================
// pollUntilMerged — pure function unit tests
// ===========================================================================

describe('pollUntilMerged (pure)', () => {
  test('returns success on first fetch when state is already merged', async () => {
    const clock = fakeClock();
    const result = await pollUntilMerged({
      fetchState: () => ({ state: 'merged', url: 'u', mergeCommitSha: 'abc' }),
      intervalMs: 10000,
      timeoutMs: 60000,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.state).toBe('merged');
      expect(result.state.mergeCommitSha).toBe('abc');
    }
    expect(clock.sleepCount()).toBe(0);
  });

  test('polls until merged appears, then returns', async () => {
    const clock = fakeClock();
    const states: Array<'open' | 'merged'> = ['open', 'open', 'open', 'merged'];
    let i = 0;
    const result = await pollUntilMerged({
      fetchState: () => ({
        state: states[i++] ?? 'merged',
        url: 'u',
        mergeCommitSha: i === states.length ? 'sha' : undefined,
      }),
      intervalMs: 10000,
      timeoutMs: 600000,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(result.ok).toBe(true);
    expect(clock.sleepCount()).toBe(3); // three polls returned 'open' before the fourth merged
  });

  test('returns timeout when budget exhausted before merge', async () => {
    const clock = fakeClock();
    const result = await pollUntilMerged({
      fetchState: () => ({ state: 'open', url: 'u' }),
      intervalMs: 10000,
      timeoutMs: 30000,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === 'timeout') {
      expect(result.lastState.state).toBe('open');
    } else {
      throw new Error('expected timeout variant');
    }
  });

  test('fetch_error variant: fetchState throws on first iteration → reason=fetch_error, lastState=null', async () => {
    const clock = fakeClock();
    const result = await pollUntilMerged({
      fetchState: () => {
        throw new Error('gh: connection refused');
      },
      intervalMs: 1000,
      timeoutMs: 60000,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === 'fetch_error') {
      expect(result.error).toContain('connection refused');
      expect(result.lastState).toBeNull();
    } else {
      throw new Error('expected fetch_error variant');
    }
  });

  test('fetch_error variant: throws on later iteration → lastState preserved', async () => {
    const clock = fakeClock();
    let n = 0;
    const result = await pollUntilMerged({
      fetchState: () => {
        n += 1;
        if (n === 1) return { state: 'open' as const, url: 'u' };
        if (n === 2) return { state: 'open' as const, url: 'u' };
        throw new Error('gh: rate limited');
      },
      intervalMs: 1000,
      timeoutMs: 60000,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === 'fetch_error') {
      expect(result.error).toContain('rate limited');
      expect(result.lastState?.state).toBe('open');
    } else {
      throw new Error('expected fetch_error variant');
    }
  });

  test('timeout check happens BEFORE sleep (no wasted final interval)', async () => {
    // With timeoutMs=10000 and intervalMs=10000, after one sleep the clock is
    // at 10000ms. The next iteration fetches, sees 'open', checks elapsed >=
    // timeoutMs (10000>=10000) → timeout. Sleep count should be exactly 1, not 2.
    const clock = fakeClock();
    const result = await pollUntilMerged({
      fetchState: () => ({ state: 'open', url: 'u' }),
      intervalMs: 10000,
      timeoutMs: 10000,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(result.ok).toBe(false);
    expect(clock.sleepCount()).toBe(1);
  });
});

// ===========================================================================
// executeWait — full handler flow with mocked clock + execSync
// ===========================================================================

describe('pr_merge_wait — handler integration', () => {
  test('schema rejection: missing number', async () => {
    const result = await prMergeWaitHandler.execute({});
    const data = parseResult(result);
    expect(data.ok).toBe(false);
  });

  test('schema rejection: timeout_sec must be positive', async () => {
    const result = await prMergeWaitHandler.execute({ number: 1, timeout_sec: -5 });
    const data = parseResult(result);
    expect(data.ok).toBe(false);
  });

  test('detect-and-skip: PR already merged → no merge call, warning emitted', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git\n');
    onExec(
      'gh pr view 50 --json state,url,mergeCommit',
      JSON.stringify({
        state: 'MERGED',
        url: 'https://github.com/org/repo/pull/50',
        mergeCommit: { oid: 'preexisting' },
      }),
    );

    const result = await executeWaitForTest({ number: 50 }, 'github', {
      now: () => 0,
      sleep: async () => {},
      intervalMs: 10000,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.merged).toBe(true);
      expect(result.pr_state).toBe('MERGED');
      expect(result.merge_commit_sha).toBe('preexisting');
      expect(result.warnings.length).toBe(1);
      expect(result.warnings[0]).toContain('already merged');
    }
    // No merge call should have been issued.
    expect(execCalls.find(c => c.includes('gh pr merge'))).toBeUndefined();
  });

  test('direct merge path → returns synchronously, no polling', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git\n');
    stubNoQueue();

    // First view = pre-merge (OPEN, triggers detect-and-skip "not merged").
    // Second view = post-merge inside pr_merge (MERGED). Real direct merge
    // is synchronous, so we mirror that here.
    let viewCalls = 0;
    onExec('gh pr view 51 --json state,url,mergeCommit', () => {
      viewCalls += 1;
      const merged = viewCalls >= 2;
      return JSON.stringify({
        state: merged ? 'MERGED' : 'OPEN',
        url: 'https://github.com/org/repo/pull/51',
        mergeCommit: merged ? { oid: 'direct51' } : null,
      });
    });
    onExec('gh pr merge 51 --squash --delete-branch', '');

    const clock = fakeClock();
    const result = await executeWaitForTest({ number: 51 }, 'github', {
      now: clock.now,
      sleep: clock.sleep,
      intervalMs: 1,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.merged).toBe(true);
      expect(result.merge_method).toBe('direct_squash');
      expect(result.merge_commit_sha).toBe('direct51');
    }
    // Critical: zero polling sleeps on the direct path.
    expect(clock.sleepCount()).toBe(0);
  });

  test('queue path → polls until state flips to merged', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git\n');
    stubEnforcedQueue();

    // Pre-state: OPEN. Then merge call (--auto). Post-merge initial fetch
    // (inside pr_merge): OPEN. Polling fetches: OPEN, OPEN, MERGED.
    let viewCallCount = 0;
    onExec('gh pr view 60 --json state,url,mergeCommit', () => {
      viewCallCount += 1;
      // Calls 1 (pre-state for detect-and-skip), 2 (post-merge in pr_merge):
      // OPEN. Calls 3, 4: OPEN. Call 5+: MERGED with sha.
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
    onExec('gh pr merge 60 --squash --delete-branch --auto', '');

    const clock = fakeClock();
    const result = await executeWaitForTest({ number: 60 }, 'github', {
      now: clock.now,
      sleep: clock.sleep,
      intervalMs: 1000,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.merged).toBe(true);
      expect(result.pr_state).toBe('MERGED');
      expect(result.merge_method).toBe('merge_queue');
      expect(result.merge_commit_sha).toBe('queued-sha');
    }
    expect(clock.sleepCount()).toBeGreaterThan(0);
  });

  test('queue path → timeout returns ok:false with descriptive error', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git\n');
    stubEnforcedQueue();

    onExec(
      'gh pr view 70 --json state,url,mergeCommit',
      JSON.stringify({
        state: 'OPEN',
        url: 'https://github.com/org/repo/pull/70',
        mergeCommit: null,
      }),
    );
    onExec('gh pr merge 70 --squash --delete-branch --auto', '');

    const clock = fakeClock();
    const result = await executeWaitForTest(
      { number: 70, timeout_sec: 30 },
      'github',
      { now: clock.now, sleep: clock.sleep, intervalMs: 10000 },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('timed out after 30s');
      expect(result.error).toContain('PR #70');
      expect(result.error).toContain('queue.enforced: true');
    }
  });

  test('queue path → fetch_error mid-poll surfaces "after enrollment" context', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git\n');
    stubEnforcedQueue();

    // Pre-state: OPEN. pr_merge's post-merge fetch: OPEN. First poll fetch:
    // OPEN. Second poll fetch: throws.
    let viewCallCount = 0;
    onExec('gh pr view 71 --json state,url,mergeCommit', () => {
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
    onExec('gh pr merge 71 --squash --delete-branch --auto', '');

    const clock = fakeClock();
    const result = await executeWaitForTest({ number: 71 }, 'github', {
      now: clock.now,
      sleep: clock.sleep,
      intervalMs: 1000,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('after enrollment');
      expect(result.error).toContain('PR #71');
      expect(result.error).toContain('rate limit');
      expect(result.error).toContain('queue.enforced: true');
    }
  });

  test('pr_merge failure propagates unchanged', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git\n');
    stubNoQueue();
    onExec(
      'gh pr view 80 --json state,url,mergeCommit',
      JSON.stringify({
        state: 'OPEN',
        url: 'https://github.com/org/repo/pull/80',
        mergeCommit: null,
      }),
    );
    onExec('gh pr merge 80 --squash --delete-branch', () => {
      const err = new Error('Pull request is not mergeable: conflicts') as ThrowableError;
      err.stderr = 'Pull request is not mergeable: conflicts\n';
      throw err;
    });

    const result = await executeWaitForTest({ number: 80 }, 'github', {
      now: () => 0,
      sleep: async () => {},
      intervalMs: 1,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('gh pr merge failed');
    }
  });

  test('initial state-fetch failure surfaces a clear error', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git\n');
    onExec('gh pr view 90 --json state,url,mergeCommit', () => {
      throw new Error('PR not found');
    });

    const result = await executeWaitForTest({ number: 90 }, 'github', {
      now: () => 0,
      sleep: async () => {},
      intervalMs: 1,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('failed to read initial PR state');
      expect(result.error).toContain('PR not found');
    }
  });

  test('handler exports valid HandlerDef shape', () => {
    expect(prMergeWaitHandler.name).toBe('pr_merge_wait');
    expect(typeof prMergeWaitHandler.execute).toBe('function');
  });
});
