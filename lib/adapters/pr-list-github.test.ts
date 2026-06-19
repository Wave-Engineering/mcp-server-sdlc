import { describe, test, expect, beforeEach } from 'bun:test';
import type { AdapterResult, PrListResponse } from './types.ts';
import {
  installChildProcessMock,
  onExec,
  resetExecMock,
  execCalls,
} from '../test-support/mock-child-process.ts';

// Subprocess-boundary tests for the GitHub pr_list adapter (R-15).
// Integration-level coverage (handler dispatch, error envelope, slug routing)
// stays in tests/pr_list.test.ts; this file owns the argv-shape and
// response-parsing assertions that prove the adapter speaks `gh` correctly,
// plus the state/author filter argv translation.

interface ThrowableError extends Error {
  stderr?: string;
  stdout?: string;
  status?: number;
}

function unquote(cmd: string): string {
  return cmd.replace(/'([^']*)'/g, '$1');
}

installChildProcessMock();

const { prListGithub } = await import('./pr-list-github.ts');

// Narrow AdapterResult into the success branch — throws if it's an error or
// platform_unsupported variant. Lets test bodies access `.data` directly
// without nested `if ('ok' in r && r.ok)` ceremony at every assertion.
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

describe('prListGithub — subprocess boundary', () => {
  test('gh CLI invocation matches expected argv shape (happy path)', async () => {
    onExec(
      'gh pr list',
      JSON.stringify([
        {
          number: 7,
          title: 'Some PR',
          state: 'OPEN',
          headRefName: 'feature/42-thing',
          baseRefName: 'main',
          url: 'https://github.com/org/repo/pull/7',
        },
      ]),
    );

    const result = await prListGithub({
      head: 'feature/42-thing',
      state: 'open',
      limit: 20,
    });
    expectOk(result);

    const call = unquote(findCall('gh pr list'));
    expect(call).toContain('--head feature/42-thing');
    expect(call).toContain('--state open');
    expect(call).toContain('--limit 20');
    expect(call).toContain('--json');
    expect(call).toContain('number,title,state,headRefName,baseRefName,url');
    // No --repo flag absent an explicit slug.
    expect(call).not.toContain('--repo');
    // No --author or --base flags when not provided.
    expect(call).not.toContain('--author');
    expect(call).not.toContain('--base');
  });

  test('parses gh pr list JSON response into PrListResponse with normalized fields', async () => {
    onExec(
      'gh pr list',
      JSON.stringify([
        {
          number: 12,
          title: 'Refactor',
          state: 'OPEN',
          headRefName: 'feature/12-refactor',
          baseRefName: 'develop',
          url: 'https://github.com/org/repo/pull/12',
        },
        {
          number: 13,
          title: 'Bugfix',
          state: 'CLOSED',
          headRefName: 'fix/13-bug',
          baseRefName: 'main',
          url: 'https://github.com/org/repo/pull/13',
        },
      ]),
    );

    const result = await prListGithub({ state: 'all', limit: 20 });
    expectOk(result);
    expect(result.data.prs).toEqual([
      {
        number: 12,
        title: 'Refactor',
        state: 'OPEN',
        head: 'feature/12-refactor',
        base: 'develop',
        url: 'https://github.com/org/repo/pull/12',
      },
      {
        number: 13,
        title: 'Bugfix',
        state: 'CLOSED',
        head: 'fix/13-bug',
        base: 'main',
        url: 'https://github.com/org/repo/pull/13',
      },
    ]);
  });

  test('empty result list returns {prs: []} (not an error)', async () => {
    onExec('gh pr list', JSON.stringify([]));

    const result = await prListGithub({
      head: 'feature/99-none',
      state: 'open',
      limit: 20,
    });
    expectOk(result);
    expect(result.data.prs).toEqual([]);
  });

  test('--state argv translation: each enum value passes through verbatim', async () => {
    onExec('gh pr list', JSON.stringify([]));

    for (const state of ['open', 'closed', 'merged', 'all'] as const) {
      resetExecMock();
      await prListGithub({ state, limit: 20 });
      const call = unquote(findCall('gh pr list'));
      expect(call).toContain(`--state ${state}`);
    }
  });

  test('--author flag forwarded only when args.author provided', async () => {
    onExec('gh pr list', JSON.stringify([]));

    // With author
    await prListGithub({ author: '@me', state: 'open', limit: 20 });
    let call = unquote(findCall('gh pr list'));
    expect(call).toContain('--author @me');

    // Without author
    resetExecMock();
    await prListGithub({ state: 'open', limit: 20 });
    call = unquote(findCall('gh pr list'));
    expect(call).not.toContain('--author');
  });

  test('--base flag forwarded only when args.base provided', async () => {
    onExec('gh pr list', JSON.stringify([]));

    await prListGithub({ base: 'main', state: 'open', limit: 20 });
    const call = unquote(findCall('gh pr list'));
    expect(call).toContain('--base main');
  });

  test('custom limit is rendered into the --limit argv value', async () => {
    onExec('gh pr list', JSON.stringify([]));

    await prListGithub({ state: 'open', limit: 5 });
    const call = unquote(findCall('gh pr list'));
    expect(call).toContain('--limit 5');
  });

  test('returns AdapterResult{ok:false, code} on gh failure (not thrown)', async () => {
    onExec('gh pr list', () => {
      const err = new Error('gh: not authenticated') as ThrowableError;
      err.stderr = 'gh: not authenticated';
      err.status = 4;
      throw err;
    });

    const result = await prListGithub({ state: 'open', limit: 20 });
    expectErr(result);
    expect(result.code).toBe('gh_pr_list_failed');
    expect(result.error).toContain('gh pr list failed');
  });

  test('--repo flag forwarded when args.repo provided', async () => {
    onExec('gh pr list', JSON.stringify([]));

    await prListGithub({ state: 'open', limit: 20, repo: 'Org/Other' });
    const call = unquote(findCall('gh pr list'));
    expect(call).toContain('--repo Org/Other');
  });

  test('returns AdapterResult{ok:false, code:unexpected_error} when JSON.parse throws', async () => {
    onExec('gh pr list', 'not json at all');

    const result = await prListGithub({ state: 'open', limit: 20 });
    expectErr(result);
    expect(result.code).toBe('unexpected_error');
  });
});
