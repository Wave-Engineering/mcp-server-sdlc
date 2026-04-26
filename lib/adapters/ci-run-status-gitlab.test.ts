import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { AdapterResult, CiRunStatusResponse } from './types.ts';

// Subprocess-boundary tests for the GitLab ci_run_status adapter (R-15).
// Integration-level coverage (handler envelope + detectPlatform dispatch)
// stays in tests/ci_run_status.test.ts; this file owns the argv-shape and
// enum-normalization assertions.
//
// The adapter routes its subprocess through `gitlabApiCiList` in
// `lib/glab.ts` (per Story 2.13 spec note — `lib/glab.ts` deletion is
// deferred to Phase 3 Story 3.1). That means we mock `child_process.execSync`
// directly AND stub `parseRepoSlug` so `gitlabApiCiList`'s `git remote` peek
// doesn't need a real repo.

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

const { ciRunStatusGitlab } = await import('./ci-run-status-gitlab.ts');

function on(match: string, respond: string | (() => string)): void {
  execRegistry.push({ match, respond });
}

function expectOk(
  r: AdapterResult<CiRunStatusResponse>,
): asserts r is { ok: true; data: CiRunStatusResponse } {
  if (!('ok' in r) || !r.ok) {
    throw new Error(`expected ok result, got ${JSON.stringify(r)}`);
  }
}

function expectErr(
  r: AdapterResult<CiRunStatusResponse>,
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

describe('ciRunStatusGitlab — subprocess boundary', () => {
  // --- argv + normalization for the three status enum families ---

  test('argv: glab api pipelines?ref=... per_page=1 by default; normalizes success', async () => {
    on(
      'glab api projects/org%2Frepo/pipelines?ref=',
      JSON.stringify([
        {
          id: 555,
          status: 'success',
          web_url: 'https://gitlab.com/org/repo/-/pipelines/555',
          ref: 'feature/5-gl',
          sha: 'aabbccddeeff0011223344556677889900aabbcc',
          created_at: '2025-04-04T12:00:00Z',
          updated_at: '2025-04-04T12:05:00Z',
          finished_at: '2025-04-04T12:05:00Z',
          source: 'push',
        },
      ]),
    );

    const result = await ciRunStatusGitlab({ ref: 'feature/5-gl' });
    expectOk(result);
    const run = result.data!;
    expect(run.run_id).toBe(555);
    expect(run.status).toBe('completed');
    expect(run.conclusion).toBe('success');
    expect(run.url).toBe('https://gitlab.com/org/repo/-/pipelines/555');
    expect(run.ref).toBe('feature/5-gl');
    expect(run.workflow_name).toBe('push');
    expect(run.finished_at).toBe('2025-04-04T12:05:00Z');

    const call = findCall('glab api');
    expect(call).toContain('projects/org%2Frepo/pipelines');
    expect(call).toContain('ref=feature%2F5-gl');
    expect(call).toContain('per_page=1');
  });

  test('normalizes failed → failure conclusion', async () => {
    on(
      'glab api projects/org%2Frepo/pipelines?ref=',
      JSON.stringify([
        {
          id: 42,
          status: 'failed',
          web_url: 'https://gitlab.com/org/repo/-/pipelines/42',
          ref: 'main',
          sha: '11223344556677889900aabbccddeeff00112233',
          created_at: '2025-05-05T00:00:00Z',
          updated_at: '2025-05-05T00:10:00Z',
          finished_at: '2025-05-05T00:10:00Z',
          source: 'merge_request_event',
        },
      ]),
    );

    const result = await ciRunStatusGitlab({ ref: 'main' });
    expectOk(result);
    expect(result.data!.status).toBe('completed');
    expect(result.data!.conclusion).toBe('failure');
  });

  test('normalizes canceled/cancelled → cancelled', async () => {
    on(
      'glab api projects/org%2Frepo/pipelines?ref=',
      JSON.stringify([
        {
          id: 43,
          status: 'canceled',
          web_url: 'https://gitlab.com/org/repo/-/pipelines/43',
          ref: 'main',
          sha: '2222222222222222222222222222222222222222',
          created_at: '2025-06-06T00:00:00Z',
          updated_at: '2025-06-06T00:01:00Z',
          source: 'push',
        },
      ]),
    );

    const result = await ciRunStatusGitlab({ ref: 'main' });
    expectOk(result);
    expect(result.data!.status).toBe('completed');
    expect(result.data!.conclusion).toBe('cancelled');
  });

  test('normalizes running → in_progress with null conclusion', async () => {
    on(
      'glab api projects/org%2Frepo/pipelines?ref=',
      JSON.stringify([
        {
          id: 44,
          status: 'running',
          web_url: 'https://gitlab.com/org/repo/-/pipelines/44',
          ref: 'main',
          sha: '3333333333333333333333333333333333333333',
          created_at: '2025-07-07T00:00:00Z',
          updated_at: '2025-07-07T00:02:00Z',
          source: 'push',
        },
      ]),
    );

    const result = await ciRunStatusGitlab({ ref: 'main' });
    expectOk(result);
    expect(result.data!.status).toBe('in_progress');
    expect(result.data!.conclusion).toBeNull();
    // running + no explicit finished_at + not completed → finished_at null
    expect(result.data!.finished_at).toBeNull();
  });

  test('normalizes queued-family (pending/created/preparing → queued)', async () => {
    on(
      'glab api projects/org%2Frepo/pipelines?ref=',
      JSON.stringify([
        {
          id: 45,
          status: 'pending',
          web_url: 'https://gitlab.com/org/repo/-/pipelines/45',
          ref: 'main',
          sha: '4444444444444444444444444444444444444444',
          created_at: '2025-08-08T00:00:00Z',
          updated_at: '2025-08-08T00:00:00Z',
          source: 'push',
        },
      ]),
    );

    const result = await ciRunStatusGitlab({ ref: 'main' });
    expectOk(result);
    expect(result.data!.status).toBe('queued');
    expect(result.data!.conclusion).toBeNull();
  });

  test('workflow_name filters client-side against `source`; uses per_page=20', async () => {
    on(
      'glab api projects/org%2Frepo/pipelines?ref=main&per_page=20',
      JSON.stringify([
        {
          id: 1,
          status: 'success',
          web_url: 'https://gitlab.com/org/repo/-/pipelines/1',
          ref: 'main',
          sha: 'aa11bb22cc33dd44ee55ff6677889900aabbccdd',
          created_at: '2025-06-06T00:00:00Z',
          updated_at: '2025-06-06T00:01:00Z',
          finished_at: '2025-06-06T00:01:00Z',
          source: 'push',
        },
        {
          id: 2,
          status: 'success',
          web_url: 'https://gitlab.com/org/repo/-/pipelines/2',
          ref: 'main',
          sha: 'bb22cc33dd44ee55ff66778899001122334455aa',
          created_at: '2025-06-06T00:02:00Z',
          updated_at: '2025-06-06T00:03:00Z',
          finished_at: '2025-06-06T00:03:00Z',
          source: 'schedule',
        },
      ]),
    );

    const result = await ciRunStatusGitlab({ ref: 'main', workflow_name: 'schedule' });
    expectOk(result);
    expect(result.data!.run_id).toBe(2);
    expect(result.data!.workflow_name).toBe('schedule');

    const call = findCall('per_page=20');
    expect(call).toContain('per_page=20');
  });

  test('explicit repo targets encoded other-org/other-repo', async () => {
    on(
      'glab api projects/other-org%2Fother-repo/pipelines?ref=',
      JSON.stringify([
        {
          id: 9002,
          status: 'success',
          web_url: 'https://gitlab.com/other-org/other-repo/-/pipelines/9002',
          ref: 'main',
          sha: '5555555555555555555555555555555555555555',
          created_at: '2026-04-07T12:00:00Z',
          updated_at: '2026-04-07T12:05:00Z',
          finished_at: '2026-04-07T12:05:00Z',
          source: 'push',
        },
      ]),
    );

    const result = await ciRunStatusGitlab({ ref: 'main', repo: 'other-org/other-repo' });
    expectOk(result);
    const call = findCall('glab api');
    expect(call).toContain('projects/other-org%2Fother-repo/pipelines');
    expect(call).not.toContain('projects/org%2Frepo/pipelines');
  });

  // --- null return when no matching run ---

  test('null return when the pipeline list is empty', async () => {
    on('glab api projects/org%2Frepo/pipelines?ref=', JSON.stringify([]));

    const result = await ciRunStatusGitlab({ ref: 'branch-no-runs' });
    expectOk(result);
    expect(result.data).toBeNull();
  });

  test('null return when workflow_name filter matches nothing', async () => {
    on(
      'glab api projects/org%2Frepo/pipelines?ref=main&per_page=20',
      JSON.stringify([
        {
          id: 10,
          status: 'success',
          web_url: 'https://gitlab.com/org/repo/-/pipelines/10',
          ref: 'main',
          sha: 'cc33dd44ee55ff66778899001122334455aabbcc',
          created_at: '2025-07-07T00:00:00Z',
          updated_at: '2025-07-07T00:01:00Z',
          source: 'push',
        },
      ]),
    );

    const result = await ciRunStatusGitlab({ ref: 'main', workflow_name: 'release' });
    expectOk(result);
    expect(result.data).toBeNull();
  });

  // --- error surface ---

  test('returns AdapterResult.error on glab failure (not thrown)', async () => {
    on('glab api', () => {
      const err = new Error('glab: 401 unauthorized') as ThrowableError;
      err.stderr = 'glab: 401 unauthorized';
      err.status = 1;
      throw err;
    });

    const result = await ciRunStatusGitlab({ ref: 'main' });
    expectErr(result);
    expect(result.code).toBe('glab_api_pipelines_failed');
    expect(result.error).toContain('401 unauthorized');
  });
});
