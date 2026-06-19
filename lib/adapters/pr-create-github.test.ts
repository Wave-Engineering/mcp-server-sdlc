import { describe, test, expect, beforeEach } from 'bun:test';
import {
  installChildProcessMock,
  onExec,
  resetExecMock,
  execCalls,
  mockExecSync,
} from '../test-support/mock-child-process.ts';
import type { AdapterResult, PrCreateResponse } from './types.ts';

// Subprocess-boundary tests for the GitHub pr_create adapter (R-15).
// Integration-level coverage (handler dispatch, error envelope, idempotency)
// stays in tests/pr_create.test.ts; this file owns the argv-shape and
// response-parsing assertions that prove the adapter speaks `gh` correctly.

interface ThrowableError extends Error {
  stderr?: string;
  stdout?: string;
  status?: number;
}

function unquote(cmd: string): string {
  return cmd.replace(/'([^']*)'/g, '$1');
}

installChildProcessMock();

const { prCreateGithub } = await import('./pr-create-github.ts');

// Narrow AdapterResult into the success branch — throws if it's an error or
// platform_unsupported variant. Lets test bodies access `.data` directly
// without nested `if ('ok' in r && r.ok)` ceremony at every assertion.
function expectOk(
  r: AdapterResult<PrCreateResponse>,
): asserts r is { ok: true; data: PrCreateResponse } {
  if (!('ok' in r) || !r.ok) {
    throw new Error(`expected ok result, got ${JSON.stringify(r)}`);
  }
}

function expectErr(
  r: AdapterResult<PrCreateResponse>,
): asserts r is { ok: false; error: string; code: string } {
  if (!('ok' in r) || r.ok) {
    throw new Error(`expected error result, got ${JSON.stringify(r)}`);
  }
}

function findCall(needle: string): string {
  return execCalls().find((c) => c.includes(needle) || unquote(c).includes(needle)) ?? '';
}

function optsForCall(needle: string): { cwd?: string } | undefined {
  const idx = execCalls().findIndex(
    (c) => c.includes(needle) || unquote(c).includes(needle),
  );
  return idx >= 0
    ? (mockExecSync.mock.calls[idx]?.[1] as { cwd?: string } | undefined)
    : undefined;
}

beforeEach(() => {
  resetExecMock();
});

describe('prCreateGithub — subprocess boundary', () => {
  test('gh CLI invocation matches expected argv shape (happy path)', async () => {
    onExec('git branch --show-current', 'feature/x\n');
    onExec(
      'gh pr create',
      'https://github.com/owner/repo/pull/42\n',
    );
    onExec(
      'gh pr view',
      JSON.stringify({
        number: 42,
        url: 'https://github.com/owner/repo/pull/42',
        state: 'OPEN',
        headRefName: 'feature/x',
        baseRefName: 'main',
      }),
    );

    const result = await prCreateGithub({
      title: 'a title',
      body: 'a body',
      base: 'main',
    });

    expectOk(result);
    expect(result.data.number).toBe(42);

    const createCall = findCall('gh pr create');
    expect(createCall).toContain('--title');
    expect(createCall).toContain('a title');
    expect(createCall).toContain('--body');
    expect(createCall).toContain('a body');
    expect(createCall).toContain('--base');
    expect(createCall).toContain('main');
    expect(createCall).toContain('--head');
    expect(createCall).toContain('feature/x');
    // Draft flag absent when not requested.
    expect(createCall).not.toContain('--draft');
  });

  test('parses gh pr view response into PrCreateResponse', async () => {
    onExec('git branch --show-current', 'feature/y\n');
    onExec('gh pr create', 'https://github.com/o/r/pull/7\n');
    onExec(
      'gh pr view',
      JSON.stringify({
        number: 7,
        url: 'https://github.com/o/r/pull/7',
        state: 'OPEN',
        headRefName: 'feature/y',
        baseRefName: 'develop',
      }),
    );

    const result = await prCreateGithub({ title: 't', body: 'b', base: 'develop' });
    expectOk(result);
    expect(result.data).toEqual({
      number: 7,
      url: 'https://github.com/o/r/pull/7',
      state: 'open',
      head: 'feature/y',
      base: 'develop',
      created: true,
    });
  });

  test('returns AdapterResult{ok:false, code} on gh failure (not thrown)', async () => {
    onExec('git branch --show-current', 'feature/z\n');
    onExec('gh pr create', () => {
      const err = new Error('gh: auth required') as ThrowableError;
      err.stderr = 'gh: auth required';
      err.status = 4;
      throw err;
    });

    const result = await prCreateGithub({ title: 't', body: 'b', base: 'main' });
    expectErr(result);
    expect(result.code).toBe('gh_pr_create_failed');
    expect(result.error).toContain('gh pr create failed');
  });

  test('idempotent path: "already exists" → looks up existing PR and returns created:false', async () => {
    onExec('git branch --show-current', 'feature/dup\n');
    onExec('gh pr create', () => {
      const err = new Error('a pull request for branch already exists') as ThrowableError;
      err.stderr = 'a pull request for branch already exists';
      err.status = 1;
      throw err;
    });
    onExec(
      'gh pr list',
      JSON.stringify([
        {
          number: 99,
          url: 'https://github.com/o/r/pull/99',
          state: 'OPEN',
          headRefName: 'feature/dup',
          baseRefName: 'main',
        },
      ]),
    );

    const result = await prCreateGithub({ title: 't', body: 'b', base: 'main' });
    expectOk(result);
    expect(result.data.number).toBe(99);
    expect(result.data.created).toBe(false);
  });

  test('--draft flag added when args.draft=true', async () => {
    onExec('git branch --show-current', 'draft-branch\n');
    onExec('gh pr create', 'https://github.com/o/r/pull/3\n');
    onExec(
      'gh pr view',
      JSON.stringify({
        number: 3,
        url: 'https://github.com/o/r/pull/3',
        state: 'OPEN',
        headRefName: 'draft-branch',
        baseRefName: 'main',
      }),
    );

    await prCreateGithub({ title: 't', body: 'b', base: 'main', draft: true });
    expect(findCall('gh pr create')).toContain('--draft');
  });

  test('--repo flag forwarded when args.repo provided', async () => {
    onExec('git branch --show-current', 'feature/cross\n');
    onExec('gh pr create', 'https://github.com/Org/Other/pull/12\n');
    onExec(
      'gh pr view',
      JSON.stringify({
        number: 12,
        url: 'https://github.com/Org/Other/pull/12',
        state: 'OPEN',
        headRefName: 'feature/cross',
        baseRefName: 'main',
      }),
    );

    await prCreateGithub({ title: 't', body: 'b', base: 'main', repo: 'Org/Other' });
    const create = findCall('gh pr create');
    expect(create).toContain('--repo');
    expect(create).toContain('Org/Other');
    const view = findCall('gh pr view');
    expect(view).toContain('--repo');
    expect(view).toContain('Org/Other');
  });

  test('runs gh in args.cwd when supplied (#453)', async () => {
    onExec('git branch --show-current', 'feature/rooted\n');
    onExec('gh pr create', 'https://github.com/o/r/pull/77\n');
    onExec(
      'gh pr view',
      JSON.stringify({
        number: 77,
        url: 'https://github.com/o/r/pull/77',
        state: 'OPEN',
        headRefName: 'feature/rooted',
        baseRefName: 'main',
      }),
    );

    await prCreateGithub({ title: 't', body: 'b', base: 'main', cwd: '/work/tree' });
    // Every subprocess (branch probe, create, view) runs in the threaded cwd.
    expect(optsForCall('git branch --show-current')?.cwd).toBe('/work/tree');
    expect(optsForCall('gh pr create')?.cwd).toBe('/work/tree');
    expect(optsForCall('gh pr view')?.cwd).toBe('/work/tree');
  });

  test('default-branch resolution via gh repo view when args.base is undefined', async () => {
    onExec('git branch --show-current', 'feature/no-base\n');
    onExec('gh repo view', 'develop\n');
    onExec('gh pr create', 'https://github.com/o/r/pull/55\n');
    onExec(
      'gh pr view',
      JSON.stringify({
        number: 55,
        url: 'https://github.com/o/r/pull/55',
        state: 'OPEN',
        headRefName: 'feature/no-base',
        baseRefName: 'develop',
      }),
    );

    const result = await prCreateGithub({ title: 't', body: 'b' });
    expectOk(result);
    const probe = findCall('gh repo view');
    expect(probe).toContain('--json');
    expect(probe).toContain('defaultBranchRef');
    expect(probe).toContain('--jq');
    // Confirm the resolved value flowed into the create call's --base.
    const create = findCall('gh pr create');
    expect(create).toContain('--base');
    expect(create).toContain('develop');
  });
});
