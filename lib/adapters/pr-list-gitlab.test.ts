import { describe, test, expect, beforeEach } from 'bun:test';
import {
  onExec,
  execCalls,
  resetExecMock,
  installChildProcessMock,
} from '../test-support/mock-child-process.ts';
import type { AdapterResult, PrListResponse } from './types.ts';

// Subprocess-boundary tests for the GitLab pr_list adapter (R-15).
// Integration-level coverage stays in tests/pr_list.test.ts. This file
// covers argv-shape, MR-list parsing, and state/author filter argv
// translation through `gitlabApiMrList`.

interface ThrowableError extends Error {
  stderr?: string;
  stdout?: string;
  status?: number;
}

function unquote(cmd: string): string {
  return cmd.replace(/'([^']*)'/g, '$1');
}

installChildProcessMock();

const { prListGitlab } = await import('./pr-list-gitlab.ts');

function expectOk(
  r: AdapterResult<PrListResponse>,
): asserts r is { ok: true; data: PrListResponse } {
  if (!('ok' in r) || !r.ok) {
    throw new Error(`expected ok result, got ${JSON.stringify(r)}`);
  }
}

function expectErr(
  r: AdapterResult<PrListResponse>,
): asserts r is { ok: false; error: string; code: string } {
  if (!('ok' in r) || r.ok) {
    throw new Error(`expected error result, got ${JSON.stringify(r)}`);
  }
}

function findCall(needle: string): string {
  return execCalls().find((c) => c.includes(needle) || unquote(c).includes(needle)) ?? '';
}

beforeEach(() => {
  resetExecMock();
});

describe('prListGitlab — subprocess boundary', () => {
  test('glab API call matches expected URL shape (happy path with cwd slug)', async () => {
    onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    onExec(
      'glab api projects/org%2Frepo/merge_requests?state=opened&source_branch=feature%2F5-thing&per_page=20',
      JSON.stringify([
        {
          iid: 5,
          title: 'Some MR',
          state: 'opened',
          source_branch: 'feature/5-thing',
          target_branch: 'main',
          web_url: 'https://gitlab.com/org/repo/-/merge_requests/5',
          labels: [],
        },
      ]),
    );

    const result = await prListGitlab({
      head: 'feature/5-thing',
      state: 'open',
      limit: 20,
    });
    expectOk(result);

    const call = findCall('glab api projects/');
    expect(call).toContain('org%2Frepo');
    expect(call).toContain('merge_requests');
    expect(call).toContain('state=opened');
    expect(call).toContain('source_branch=feature%2F5-thing');
  });

  test('parses MR list response with normalized field names (iid→number, source/target_branch→head/base)', async () => {
    onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    onExec(
      'glab api projects/org%2Frepo/merge_requests',
      JSON.stringify([
        {
          iid: 21,
          title: 'Docs update',
          state: 'opened',
          source_branch: 'docs/21-update',
          target_branch: 'main',
          web_url: 'https://gitlab.com/org/repo/-/merge_requests/21',
          labels: [],
        },
        {
          iid: 22,
          title: 'Feature work',
          state: 'merged',
          source_branch: 'feature/22-x',
          target_branch: 'develop',
          web_url: 'https://gitlab.com/org/repo/-/merge_requests/22',
          labels: [],
        },
      ]),
    );

    const result = await prListGitlab({ state: 'all', limit: 20 });
    expectOk(result);
    expect(result.data.prs).toEqual([
      {
        number: 21,
        title: 'Docs update',
        state: 'opened',
        head: 'docs/21-update',
        base: 'main',
        url: 'https://gitlab.com/org/repo/-/merge_requests/21',
      },
      {
        number: 22,
        title: 'Feature work',
        state: 'merged',
        head: 'feature/22-x',
        base: 'develop',
        url: 'https://gitlab.com/org/repo/-/merge_requests/22',
      },
    ]);
  });

  test('state argv translation: open→opened, merged→merged, all→omitted', async () => {
    onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    onExec('glab api projects/org%2Frepo/merge_requests', JSON.stringify([]));

    // open → opened
    await prListGitlab({ state: 'open', limit: 20 });
    let call = findCall('glab api projects/');
    expect(call).toContain('state=opened');

    // merged → merged
    execCalls().length = 0;
    await prListGitlab({ state: 'merged', limit: 20 });
    call = findCall('glab api projects/');
    expect(call).toContain('state=merged');

    // all → no state= param at all
    execCalls().length = 0;
    await prListGitlab({ state: 'all', limit: 20 });
    call = findCall('glab api projects/');
    expect(call).not.toContain('state=');
  });

  test('--author flag forwarded as author_username only when provided', async () => {
    onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    onExec('glab api projects/org%2Frepo/merge_requests', JSON.stringify([]));

    await prListGitlab({ author: 'alice', state: 'open', limit: 20 });
    let call = findCall('glab api projects/');
    expect(call).toContain('author_username=alice');

    execCalls().length = 0;
    await prListGitlab({ state: 'open', limit: 20 });
    call = findCall('glab api projects/');
    expect(call).not.toContain('author_username');
  });

  test('limit rendered as per_page query param', async () => {
    onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    onExec('glab api projects/org%2Frepo/merge_requests', JSON.stringify([]));

    await prListGitlab({ state: 'open', limit: 5 });
    const call = findCall('glab api projects/');
    expect(call).toContain('per_page=5');
  });

  test('args.repo slug routed into glab api path (URL-encoded), overriding cwd remote', async () => {
    // No `git remote get-url origin` mock — explicit slug should bypass it.
    onExec(
      'glab api projects/target-org%2Ftarget-repo/merge_requests',
      JSON.stringify([]),
    );

    const result = await prListGitlab({
      state: 'open',
      limit: 20,
      repo: 'target-org/target-repo',
    });
    expectOk(result);

    const call = findCall('glab api projects/');
    expect(call).toContain('target-org%2Ftarget-repo');
  });

  test('empty result returns {prs: []} (not an error)', async () => {
    onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    onExec('glab api projects/org%2Frepo/merge_requests', JSON.stringify([]));

    const result = await prListGitlab({
      head: 'feature/99-none',
      state: 'open',
      limit: 20,
    });
    expectOk(result);
    expect(result.data.prs).toEqual([]);
  });

  test('returns AdapterResult{ok:false, code} on glab failure (not thrown)', async () => {
    onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    onExec('glab api projects/org%2Frepo/merge_requests', () => {
      const err = new Error('glab: not authenticated') as ThrowableError;
      err.stderr = 'glab: not authenticated';
      err.status = 1;
      throw err;
    });

    const result = await prListGitlab({ state: 'open', limit: 20 });
    expectErr(result);
    expect(result.code).toBe('unexpected_error');
    expect(result.error).toContain('glab');
  });

  test('base/target_branch flag forwarded only when provided', async () => {
    onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    onExec('glab api projects/org%2Frepo/merge_requests', JSON.stringify([]));

    await prListGitlab({ base: 'main', state: 'open', limit: 20 });
    const call = findCall('glab api projects/');
    expect(call).toContain('target_branch=main');
  });
});
