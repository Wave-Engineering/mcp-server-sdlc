import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { AdapterResult, CiListRunsResponse } from './types.ts';

// Subprocess-boundary tests for the GitLab ciListRuns adapter (R-15).
// Integration-level coverage stays in tests/ci_wait_run.test.ts; this file
// owns the argv-shape and normalization assertions.
//
// The adapter routes its subprocess through `gitlabApiCiList` in
// `lib/glab.ts` today (per Story 2.19 spec — `lib/glab.ts` deletion is
// deferred to Phase 3 Story 3.1). So we mock `child_process.execSync`
// directly AND stub `parseRepoSlug` so `gitlabApiCiList`'s `git remote`
// peek doesn't need a real repo.

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
mock.module('../shared/parse-repo-slug.js', () => ({
  parseRepoSlug: () => 'org/repo',
}));

const { ciListRunsGitlab } = await import('./ci-list-runs-gitlab.ts');

function on(match: string, respond: string | (() => string)): void {
  execRegistry.push({ match, respond });
}

function expectOk(
  r: AdapterResult<CiListRunsResponse>,
): asserts r is { ok: true; data: CiListRunsResponse } {
  if (!('ok' in r) || !r.ok) {
    throw new Error(`expected ok result, got ${JSON.stringify(r)}`);
  }
}

function expectErr(
  r: AdapterResult<CiListRunsResponse>,
): asserts r is { ok: false; error: string; code: string } {
  if (!('ok' in r) || r.ok) {
    throw new Error(`expected error result, got ${JSON.stringify(r)}`);
  }
}

function findCall(needle: string): string {
  return execCalls.find((c) => c.includes(needle) || unquote(c).includes(needle)) ?? '';
}

function glPipeline(overrides: Record<string, unknown> = {}) {
  return {
    id: 999,
    status: 'running',
    ref: 'feature/1-demo',
    sha: '1234567890abcdef1234567890abcdef12345678',
    web_url: 'https://gitlab.com/org/repo/-/pipelines/999',
    source: 'push',
    created_at: '2026-04-07T12:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  execRegistry = [];
  execCalls = [];
});

describe('ciListRunsGitlab — subprocess boundary', () => {
  test('argv: calls glab api pipelines with ref query; normalizes with event=null', async () => {
    on('glab api projects/org%2Frepo/pipelines', JSON.stringify([glPipeline()]));

    const result = await ciListRunsGitlab({ ref: 'feature/1-demo', limit: 20 });
    expectOk(result);
    expect(result.data.length).toBe(1);
    const run = result.data[0];
    expect(run.run_id).toBe(999);
    expect(run.workflow_name).toBe('push');
    expect(run.status).toBe('running');
    expect(run.head_sha).toBe('1234567890abcdef1234567890abcdef12345678');
    expect(run.head_branch).toBe('feature/1-demo');
    // GitLab has no event concept — always null (R-03 asymmetry signal).
    expect(run.event).toBeNull();

    const call = findCall('glab api');
    expect(call).toContain('projects/org%2Frepo/pipelines');
    expect(call).toContain('ref=feature');
    expect(call).toContain('per_page=20');
  });

  test('argv: explicit repo slug is URL-encoded into projects path', async () => {
    on(
      'glab api projects/other-org%2Fother-repo/pipelines',
      JSON.stringify([glPipeline()]),
    );

    const result = await ciListRunsGitlab({
      ref: 'main',
      repo: 'other-org/other-repo',
      limit: 20,
    });
    expectOk(result);

    const call = findCall('glab api');
    expect(call).toContain('projects/other-org%2Fother-repo/pipelines');
    expect(call).not.toContain('projects/org%2Frepo');
  });

  test('expected_sha threads through as sha= query param and filters defensively', async () => {
    const target = 'a'.repeat(40);
    const other = 'b'.repeat(40);
    on(
      'glab api projects/org%2Frepo/pipelines',
      JSON.stringify([
        glPipeline({ id: 1, sha: other }),
        glPipeline({ id: 2, sha: target }),
      ]),
    );

    const result = await ciListRunsGitlab({
      ref: 'main',
      expected_sha: target,
      limit: 20,
    });
    expectOk(result);
    // Defense-in-depth: only the run with matching SHA survives.
    expect(result.data.length).toBe(1);
    expect(result.data[0].run_id).toBe(2);

    const call = findCall('glab api');
    expect(call).toContain(`sha=${target}`);
  });

  test('workflow_name filters client-side against the source field', async () => {
    on(
      'glab api projects/org%2Frepo/pipelines',
      JSON.stringify([
        glPipeline({ id: 1, source: 'push' }),
        glPipeline({ id: 2, source: 'schedule' }),
      ]),
    );

    const result = await ciListRunsGitlab({
      ref: 'main',
      workflow_name: 'schedule',
      limit: 20,
    });
    expectOk(result);
    expect(result.data.length).toBe(1);
    expect(result.data[0].run_id).toBe(2);
    expect(result.data[0].workflow_name).toBe('schedule');
  });

  test('empty pipelines list returns ok with empty data', async () => {
    on('glab api projects/org%2Frepo/pipelines', JSON.stringify([]));

    const result = await ciListRunsGitlab({ ref: 'main', limit: 20 });
    expectOk(result);
    expect(result.data).toEqual([]);
  });

  test('returns AdapterResult.error on glab failure (not thrown)', async () => {
    on('glab api', () => {
      const err = new Error('glab: not authenticated') as ThrowableError;
      err.stderr = 'glab: not authenticated';
      err.status = 1;
      throw err;
    });

    const result = await ciListRunsGitlab({ ref: 'main', limit: 20 });
    expectErr(result);
    expect(result.code).toBe('glab_api_pipelines_failed');
  });
});
