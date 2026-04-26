import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { AdapterResult, PrStatusResponse } from './types.ts';

// Subprocess-boundary tests for the GitLab pr_status adapter (R-15).
// Integration-level coverage stays in tests/pr_status.test.ts. This file
// owns the argv-shape and response-parsing assertions, the GitLab
// state + detailed_merge_status normalization table, and — most importantly —
// the Story 1.7 (#244) explicit-pipeline-fallthrough regression test that
// locks the typed `'no_pipeline_data'` outcome in place.

interface ThrowableError extends Error {
  stderr?: string;
  stdout?: string;
  status?: number;
}

let execRegistry: Array<{ match: string; respond: string | (() => string) }> = [];
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

const { prStatusGitlab, aggregateGitlabPipeline } = await import('./pr-status-gitlab.ts');

function on(match: string, respond: string | (() => string)): void {
  execRegistry.push({ match, respond });
}

function expectOk(
  r: AdapterResult<PrStatusResponse>,
): asserts r is { ok: true; data: PrStatusResponse } {
  if (!('ok' in r) || !r.ok) {
    throw new Error(`expected ok result, got ${JSON.stringify(r)}`);
  }
}

function expectErr(
  r: AdapterResult<PrStatusResponse>,
): asserts r is { ok: false; error: string; code: string } {
  if (!('ok' in r) || r.ok) {
    throw new Error(`expected error result, got ${JSON.stringify(r)}`);
  }
}

function findCall(needle: string): string {
  return execCalls.find((c) => c.includes(needle) || unquote(c).includes(needle)) ?? '';
}

beforeEach(() => {
  execRegistry = [];
  execCalls = [];
});

describe('prStatusGitlab — subprocess boundary', () => {
  test('glab API invocation matches expected URL shape (happy path)', async () => {
    on('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    on(
      'glab api projects/org%2Frepo/merge_requests/5',
      JSON.stringify({
        iid: 5,
        state: 'opened',
        detailed_merge_status: 'mergeable',
        merge_status: 'can_be_merged',
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/5',
        head_pipeline: { status: 'success' },
      }),
    );

    const result = await prStatusGitlab({ number: 5 });
    expectOk(result);
    expect(result.data.number).toBe(5);

    const call = findCall('glab api projects/');
    expect(call).toContain('merge_requests/5');
    // Slug must be URL-encoded.
    expect(call).toContain('org%2Frepo');
  });

  test('parses MR response into PrStatusResponse with success pipeline', async () => {
    on('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    on(
      'glab api projects/org%2Frepo/merge_requests/5',
      JSON.stringify({
        iid: 5,
        state: 'opened',
        detailed_merge_status: 'mergeable',
        merge_status: 'can_be_merged',
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/5',
        head_pipeline: { status: 'success' },
      }),
    );

    const result = await prStatusGitlab({ number: 5 });
    expectOk(result);
    expect(result.data).toEqual({
      number: 5,
      state: 'open',
      merge_state: 'clean',
      mergeable: true,
      checks: { total: 1, passed: 1, failed: 0, pending: 0, summary: 'all_passed' },
      url: 'https://gitlab.com/org/repo/-/merge_requests/5',
    });
  });

  test('detailed_merge_status: ci_must_pass → blocked, conflict → dirty', async () => {
    on('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    on(
      'glab api projects/org%2Frepo/merge_requests/6',
      JSON.stringify({
        iid: 6,
        state: 'opened',
        detailed_merge_status: 'ci_must_pass',
        merge_status: 'cannot_be_merged',
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/6',
        head_pipeline: { status: 'failed' },
      }),
    );

    const r1 = await prStatusGitlab({ number: 6 });
    expectOk(r1);
    expect(r1.data.merge_state).toBe('blocked');

    execRegistry = [];
    execCalls = [];
    on('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    on(
      'glab api projects/org%2Frepo/merge_requests/7',
      JSON.stringify({
        iid: 7,
        state: 'opened',
        detailed_merge_status: 'conflict',
        merge_status: 'cannot_be_merged',
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/7',
        head_pipeline: { status: 'failed' },
      }),
    );

    const r2 = await prStatusGitlab({ number: 7 });
    expectOk(r2);
    expect(r2.data.merge_state).toBe('dirty');
  });

  test('legacy merge_status fallback when detailed_merge_status absent', async () => {
    on('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    on(
      'glab api projects/org%2Frepo/merge_requests/44',
      JSON.stringify({
        iid: 44,
        state: 'opened',
        merge_status: 'can_be_merged',
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/44',
        head_pipeline: { status: 'success' },
      }),
    );

    const result = await prStatusGitlab({ number: 44 });
    expectOk(result);
    expect(result.data.merge_state).toBe('clean');
    expect(result.data.mergeable).toBe(true);
  });

  test('state normalization opened/merged/closed', async () => {
    const cases: Array<[string, PrStatusResponse['state']]> = [
      ['opened', 'open'],
      ['merged', 'merged'],
      ['closed', 'closed'],
    ];
    for (const [raw, expected] of cases) {
      execRegistry = [];
      execCalls = [];
      on('git remote get-url origin', 'https://gitlab.com/org/repo.git');
      on(
        'glab api projects/org%2Frepo/merge_requests/9',
        JSON.stringify({
          iid: 9,
          state: raw,
          detailed_merge_status: 'mergeable',
          merge_status: 'can_be_merged',
          web_url: 'https://gitlab.com/org/repo/-/merge_requests/9',
          head_pipeline: { status: 'success' },
        }),
      );

      const result = await prStatusGitlab({ number: 9 });
      expectOk(result);
      expect(result.data.state).toBe(expected);
    }
  });

  test('pipeline preferred over head_pipeline when both present', async () => {
    on('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    on(
      'glab api projects/org%2Frepo/merge_requests/8',
      JSON.stringify({
        iid: 8,
        state: 'opened',
        detailed_merge_status: 'ci_still_running',
        merge_status: 'unchecked',
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/8',
        // pipeline is the primary; head_pipeline is the fallback. When both
        // exist we prefer `pipeline`.
        pipeline: { status: 'running' },
        head_pipeline: { status: 'failed' },
      }),
    );

    const result = await prStatusGitlab({ number: 8 });
    expectOk(result);
    expect(result.data.checks.summary).toBe('pending');
    expect(result.data.merge_state).toBe('unknown');
  });

  test('returns AdapterResult{ok:false, code} on glab failure (not thrown)', async () => {
    on('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    on('glab api projects/org%2Frepo/merge_requests/77', () => {
      const err = new Error('glab: not authenticated') as ThrowableError;
      err.stderr = 'glab: not authenticated';
      err.status = 1;
      throw err;
    });

    const result = await prStatusGitlab({ number: 77 });
    expectErr(result);
    expect(result.code).toBe('unexpected_error');
    expect(result.error).toContain('glab');
  });

  test('args.repo slug routed into glab api path (URL-encoded), overriding cwd remote', async () => {
    on('git remote get-url origin', 'https://gitlab.com/cwd-org/cwd-repo.git');
    on(
      'glab api projects/target-org%2Ftarget-repo/merge_requests/3',
      JSON.stringify({
        iid: 3,
        state: 'opened',
        detailed_merge_status: 'mergeable',
        merge_status: 'can_be_merged',
        web_url: 'https://gitlab.com/target-org/target-repo/-/merge_requests/3',
        head_pipeline: { status: 'success' },
      }),
    );

    const result = await prStatusGitlab({ number: 3, repo: 'target-org/target-repo' });
    expectOk(result);

    const call = findCall('glab api projects/');
    expect(call).toContain('target-org%2Ftarget-repo');
    expect(call).not.toContain('cwd-org%2Fcwd-repo');
  });

  // -------------------------------------------------------------------------
  // Story 1.7 (#244) — explicit pipeline-status fallthrough regression
  //
  // Pre-migration handler did `mr.pipeline?.status ?? mr.head_pipeline?.status`
  // and then `aggregateGitlabPipeline(undefined)` returned `summary: 'none'`.
  // That conflated two distinct conditions: (a) MR has pipeline data but no
  // checks reported and (b) MR has no pipeline structure at all (misconfigured
  // CI). The adapter now distinguishes them with a typed `'no_pipeline_data'`
  // summary literal.
  // -------------------------------------------------------------------------
  describe('explicit pipeline-status fallthrough (R-03)', () => {
    test('MR with NO pipeline AND NO head_pipeline → summary "no_pipeline_data"', async () => {
      on('git remote get-url origin', 'https://gitlab.com/org/repo.git');
      on(
        'glab api projects/org%2Frepo/merge_requests/100',
        JSON.stringify({
          iid: 100,
          state: 'opened',
          detailed_merge_status: 'mergeable',
          merge_status: 'can_be_merged',
          web_url: 'https://gitlab.com/org/repo/-/merge_requests/100',
          // Both pipeline fields absent — the explicit-fallthrough case.
        }),
      );

      const result = await prStatusGitlab({ number: 100 });
      expectOk(result);
      expect(result.data.checks.summary).toBe('no_pipeline_data');
      expect(result.data.checks.total).toBe(0);
      expect(result.data.checks.passed).toBe(0);
      expect(result.data.checks.failed).toBe(0);
      expect(result.data.checks.pending).toBe(0);
    });

    test('MR with head_pipeline:null AND no pipeline field → summary "no_pipeline_data"', async () => {
      on('git remote get-url origin', 'https://gitlab.com/org/repo.git');
      on(
        'glab api projects/org%2Frepo/merge_requests/101',
        JSON.stringify({
          iid: 101,
          state: 'merged',
          detailed_merge_status: 'mergeable',
          merge_status: 'can_be_merged',
          web_url: 'https://gitlab.com/org/repo/-/merge_requests/101',
          head_pipeline: null,
        }),
      );

      const result = await prStatusGitlab({ number: 101 });
      expectOk(result);
      // null?.status is undefined → both undefined → no_pipeline_data.
      expect(result.data.checks.summary).toBe('no_pipeline_data');
    });

    test('MR with pipeline.status present is NOT no_pipeline_data', async () => {
      on('git remote get-url origin', 'https://gitlab.com/org/repo.git');
      on(
        'glab api projects/org%2Frepo/merge_requests/102',
        JSON.stringify({
          iid: 102,
          state: 'opened',
          detailed_merge_status: 'mergeable',
          merge_status: 'can_be_merged',
          web_url: 'https://gitlab.com/org/repo/-/merge_requests/102',
          pipeline: { status: 'success' },
        }),
      );

      const result = await prStatusGitlab({ number: 102 });
      expectOk(result);
      expect(result.data.checks.summary).toBe('all_passed');
    });

    test('MR with head_pipeline.status present is NOT no_pipeline_data', async () => {
      on('git remote get-url origin', 'https://gitlab.com/org/repo.git');
      on(
        'glab api projects/org%2Frepo/merge_requests/103',
        JSON.stringify({
          iid: 103,
          state: 'opened',
          detailed_merge_status: 'ci_must_pass',
          merge_status: 'cannot_be_merged',
          web_url: 'https://gitlab.com/org/repo/-/merge_requests/103',
          head_pipeline: { status: 'failed' },
        }),
      );

      const result = await prStatusGitlab({ number: 103 });
      expectOk(result);
      expect(result.data.checks.summary).toBe('has_failures');
    });

    test('explicit empty-string pipeline.status falls through to legacy "none" (still distinguishable)', async () => {
      on('git remote get-url origin', 'https://gitlab.com/org/repo.git');
      on(
        'glab api projects/org%2Frepo/merge_requests/104',
        JSON.stringify({
          iid: 104,
          state: 'opened',
          detailed_merge_status: 'mergeable',
          merge_status: 'can_be_merged',
          web_url: 'https://gitlab.com/org/repo/-/merge_requests/104',
          // pipeline field exists but status is empty — distinct from missing.
          pipeline: { status: '' },
        }),
      );

      const result = await prStatusGitlab({ number: 104 });
      expectOk(result);
      // Legacy `aggregateGitlabPipeline('')` path — the field exists, so we
      // do not synthesize the no_pipeline_data signal. This case is rare
      // but the discrimination matters for the regression contract.
      expect(result.data.checks.summary).toBe('none');
    });
  });
});

describe('aggregateGitlabPipeline helper', () => {
  test('undefined / empty → summary none with zero counts', () => {
    expect(aggregateGitlabPipeline(undefined)).toEqual({
      total: 0,
      passed: 0,
      failed: 0,
      pending: 0,
      summary: 'none',
    });
    expect(aggregateGitlabPipeline('')).toEqual({
      total: 0,
      passed: 0,
      failed: 0,
      pending: 0,
      summary: 'none',
    });
  });

  test('success → summary all_passed', () => {
    expect(aggregateGitlabPipeline('success')).toEqual({
      total: 1,
      passed: 1,
      failed: 0,
      pending: 0,
      summary: 'all_passed',
    });
  });

  test('failed/canceled/cancelled → summary has_failures', () => {
    for (const s of ['failed', 'canceled', 'cancelled']) {
      expect(aggregateGitlabPipeline(s).summary).toBe('has_failures');
      expect(aggregateGitlabPipeline(s).failed).toBe(1);
    }
  });

  test('running/pending/manual/etc → summary pending', () => {
    for (const s of ['running', 'pending', 'created', 'scheduled', 'manual']) {
      expect(aggregateGitlabPipeline(s).summary).toBe('pending');
      expect(aggregateGitlabPipeline(s).pending).toBe(1);
    }
  });
});
