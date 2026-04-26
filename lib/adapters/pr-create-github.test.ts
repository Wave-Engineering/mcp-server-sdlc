import { describe, test, expect, mock, beforeEach } from 'bun:test';
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

const { prCreateGithub } = await import('./pr-create-github.ts');

function on(match: string, respond: string | (() => string)): void {
  execRegistry.push({ match, respond });
}

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
  return execCalls.find((c) => c.includes(needle) || unquote(c).includes(needle)) ?? '';
}

beforeEach(() => {
  execRegistry = [];
  execCalls = [];
});

describe('prCreateGithub — subprocess boundary', () => {
  test('gh CLI invocation matches expected argv shape (happy path)', async () => {
    on('git branch --show-current', 'feature/x\n');
    on(
      'gh pr create',
      'https://github.com/owner/repo/pull/42\n',
    );
    on(
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
    on('git branch --show-current', 'feature/y\n');
    on('gh pr create', 'https://github.com/o/r/pull/7\n');
    on(
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
    on('git branch --show-current', 'feature/z\n');
    on('gh pr create', () => {
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
    on('git branch --show-current', 'feature/dup\n');
    on('gh pr create', () => {
      const err = new Error('a pull request for branch already exists') as ThrowableError;
      err.stderr = 'a pull request for branch already exists';
      err.status = 1;
      throw err;
    });
    on(
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
    on('git branch --show-current', 'draft-branch\n');
    on('gh pr create', 'https://github.com/o/r/pull/3\n');
    on(
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
    on('git branch --show-current', 'feature/cross\n');
    on('gh pr create', 'https://github.com/Org/Other/pull/12\n');
    on(
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

  test('default-branch resolution via gh repo view when args.base is undefined', async () => {
    on('git branch --show-current', 'feature/no-base\n');
    on('gh repo view', 'develop\n');
    on('gh pr create', 'https://github.com/o/r/pull/55\n');
    on(
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
