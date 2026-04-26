import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
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

const { prMergeWaitGitlab } = await import('./pr-merge-wait-gitlab.ts');
const { executeMergeWaitForTest } = await import('./pr-merge-wait-github.ts');

function on(match: string, respond: Responder) {
  execRegistry.push({ match, respond });
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
  // GitLab origin so detectPlatform() routes to gitlabAdapter.
  on('git remote get-url origin', 'https://gitlab.com/org/repo.git\n');
});

afterEach(() => {
  execRegistry = [];
  execCalls = [];
});

describe('prMergeWaitGitlab — adapter orchestration (parity)', () => {
  test('detect-and-skip: MR already merged → no merge call', async () => {
    on(
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
    expect(execCalls.find((c) => c.includes('glab mr merge'))).toBeUndefined();
  });

  test('direct merge path → returns synchronously, no polling', async () => {
    let viewCalls = 0;
    on('glab api projects/org%2Frepo/merge_requests/51', () => {
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
    on('glab mr merge 51 --squash --remove-source-branch --yes', '');

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

  test('skip_train propagates platform_unsupported from prMerge as ok:false', async () => {
    // GitLab's prMerge returns platform_unsupported for skip_train (R-03 typed
    // asymmetry). pr_merge_wait can't proceed, so it surfaces this as ok:false
    // with a descriptive code/error. Pre-state fetch happens first so we stub
    // an OPEN MR.
    on(
      'glab api projects/org%2Frepo/merge_requests/55',
      JSON.stringify({
        iid: 55,
        state: 'opened',
        source_branch: 'feature/x',
        target_branch: 'main',
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/55',
        labels: [],
      }),
    );

    const result = await prMergeWaitGitlab({
      number: 55,
      repo: 'org/repo',
      skip_train: true,
    });

    expectErr(result);
    expect(result.error).toContain('platform_unsupported');
    expect(result.error).toContain('merge trains');
  });

  test('pr_merge failure propagates unchanged', async () => {
    on(
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
    on('glab mr merge 80 --squash --remove-source-branch --yes', () => {
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
    on('glab api projects/org%2Frepo/merge_requests/90', () => {
      throw new Error('MR not found');
    });

    const result = await prMergeWaitGitlab({ number: 90, repo: 'org/repo' });

    expectErr(result);
    expect(result.error).toContain('failed to read initial PR state');
  });
});
