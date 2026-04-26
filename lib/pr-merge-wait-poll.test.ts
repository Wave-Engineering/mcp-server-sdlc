import { describe, test, expect } from 'bun:test';

// Pure-function tests for the platform-agnostic polling loop. Lifted from
// tests/pr_merge_wait.test.ts during Story 1.11 (#248) — the loop now lives
// in lib/pr-merge-wait-poll.ts and serves both the GitHub and GitLab
// pr_merge_wait adapters.
//
// No mock.module needed: pollUntilMerged is a pure function that takes its
// fetcher + clock + sleep as deps, so tests inject thunks directly.

import { pollUntilMerged, type PrStateInfo } from './pr-merge-wait-poll.ts';

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

describe('pollUntilMerged (pure)', () => {
  test('returns success on first fetch when state is already merged', async () => {
    const clock = fakeClock();
    const result = await pollUntilMerged({
      fetchState: async () => ({ state: 'merged', url: 'u', mergeCommitSha: 'abc' }),
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
      fetchState: async () => {
        const state = states[i++] ?? 'merged';
        return {
          state,
          url: 'u',
          mergeCommitSha: i === states.length ? 'sha' : undefined,
        } as PrStateInfo;
      },
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
      fetchState: async () => ({ state: 'open', url: 'u' }),
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
      fetchState: async () => {
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
      fetchState: async () => {
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
      fetchState: async () => ({ state: 'open', url: 'u' }),
      intervalMs: 10000,
      timeoutMs: 10000,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(result.ok).toBe(false);
    expect(clock.sleepCount()).toBe(1);
  });
});
