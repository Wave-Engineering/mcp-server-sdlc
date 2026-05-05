import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { AdapterResult, PrCreateResponse } from './types.ts';

// Subprocess-boundary tests for the GitLab pr_create adapter (R-15).
// Integration-level coverage stays in tests/pr_create.test.ts.

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

const { prCreateGitlab } = await import('./pr-create-gitlab.ts');

function on(match: string, respond: string | (() => string)): void {
  execRegistry.push({ match, respond });
}

// Narrow AdapterResult into the success branch — throws if it's an error or
// platform_unsupported variant. Lets test bodies access `.data` directly.
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

describe('prCreateGitlab — subprocess boundary', () => {
  test('glab CLI invocation matches expected argv shape (happy path)', async () => {
    on('git branch --show-current', 'feature/gl\n');
    on('glab mr create', 'https://gitlab.com/o/r/-/merge_requests/9\n');
    // Post-create lookup goes via `glab api projects/.../merge_requests?source_branch=...`
    // (#383 — `glab mr view -F json` does not exist on glab 1.36.0).
    on(
      'merge_requests?source_branch',
      JSON.stringify([{
        iid: 9,
        web_url: 'https://gitlab.com/o/r/-/merge_requests/9',
        state: 'opened',
        source_branch: 'feature/gl',
        target_branch: 'main',
      }]),
    );

    const result = await prCreateGitlab({
      title: 'a title',
      body: 'a body',
      base: 'main',
    });

    expectOk(result);
    expect(result.data.number).toBe(9);

    const createCall = findCall('glab mr create');
    expect(createCall).toContain('--title');
    expect(createCall).toContain('a title');
    expect(createCall).toContain('--description');
    expect(createCall).toContain('a body');
    expect(createCall).toContain('--target-branch');
    expect(createCall).toContain('main');
    expect(createCall).toContain('--source-branch');
    expect(createCall).toContain('feature/gl');
    // --yes is the load-bearing non-interactive flag for glab.
    expect(createCall).toContain('--yes');
    expect(createCall).not.toContain('--draft');
    // Regression guard for #383: post-create lookup MUST NOT use
    // `glab mr view -F json` (the broken pre-#383 form).
    expect(execCalls.some((c) => c.includes('mr view') && c.includes('-F'))).toBe(false);
  });

  test('parses post-create MR lookup response into PrCreateResponse', async () => {
    on('git branch --show-current', 'feature/y\n');
    on('glab mr create', 'created\n');
    on(
      'merge_requests?source_branch',
      JSON.stringify([{
        iid: 12,
        web_url: 'https://gitlab.com/o/r/-/merge_requests/12',
        state: 'opened',
        source_branch: 'feature/y',
        target_branch: 'develop',
      }]),
    );

    const result = await prCreateGitlab({ title: 't', body: 'b', base: 'develop' });
    expectOk(result);
    expect(result.data).toEqual({
      number: 12,
      url: 'https://gitlab.com/o/r/-/merge_requests/12',
      state: 'open',
      head: 'feature/y',
      base: 'develop',
      created: true,
    });
  });

  test('returns AdapterResult{ok:false, code} on glab failure (not thrown)', async () => {
    on('git branch --show-current', 'feature/z\n');
    on('glab mr create', () => {
      const err = new Error('glab: not authenticated') as ThrowableError;
      err.stderr = 'glab: not authenticated';
      err.status = 1;
      throw err;
    });

    const result = await prCreateGitlab({ title: 't', body: 'b', base: 'main' });
    expectErr(result);
    expect(result.code).toBe('glab_mr_create_failed');
    expect(result.error).toContain('glab mr create failed');
  });

  test('idempotent path: "already exists" → looks up existing MR and returns created:false', async () => {
    on('git branch --show-current', 'feature/dup\n');
    on('glab mr create', () => {
      const err = new Error('Another open merge request already exists') as ThrowableError;
      err.stderr = 'Another open merge request already exists';
      err.status = 1;
      throw err;
    });
    on(
      'merge_requests?source_branch',
      JSON.stringify([{
        iid: 77,
        web_url: 'https://gitlab.com/o/r/-/merge_requests/77',
        state: 'opened',
        source_branch: 'feature/dup',
        target_branch: 'main',
      }]),
    );

    const result = await prCreateGitlab({ title: 't', body: 'b', base: 'main' });
    expectOk(result);
    expect(result.data.number).toBe(77);
    expect(result.data.created).toBe(false);
  });

  test('-R flag forwarded on create when args.repo provided; lookup uses URL-encoded slug', async () => {
    on('git branch --show-current', 'feature/cross\n');
    on('glab mr create', 'created\n');
    on(
      'merge_requests?source_branch',
      JSON.stringify([{
        iid: 5,
        web_url: 'https://gitlab.com/Org/Other/-/merge_requests/5',
        state: 'opened',
        source_branch: 'feature/cross',
        target_branch: 'main',
      }]),
    );

    await prCreateGitlab({ title: 't', body: 'b', base: 'main', repo: 'Org/Other' });
    const create = findCall('glab mr create');
    expect(create).toContain('-R');
    expect(create).toContain('Org/Other');
    // Post-create lookup uses `glab api projects/<encoded>/merge_requests?...`
    // — URL-encoded slug, no `-R` flag (the API path carries the project).
    const apiLookup = findCall('merge_requests?source_branch');
    expect(apiLookup).toContain('Org%2FOther');
    expect(apiLookup).toContain('source_branch=feature%2Fcross');
  });

  test('default-branch resolution via glab api projects/<encoded> when args.base undefined', async () => {
    on('git branch --show-current', 'feature/no-base\n');
    // Post-create lookup match — registered FIRST so the MR-listing call
    // doesn't fall through to the default-branch matcher.
    on(
      'merge_requests?source_branch',
      JSON.stringify([{
        iid: 33,
        web_url: 'https://gitlab.com/Org/Repo/-/merge_requests/33',
        state: 'opened',
        source_branch: 'feature/no-base',
        target_branch: 'main',
      }]),
    );
    on(
      'glab api projects/',
      JSON.stringify({ default_branch: 'main' }),
    );
    on('glab mr create', 'created\n');

    const result = await prCreateGitlab({ title: 't', body: 'b', repo: 'Org/Repo' });
    expectOk(result);

    const probe = findCall('glab api projects/');
    // GitLab requires URL-encoded slug
    expect(probe).toContain('Org%2FRepo');
    // Confirm resolved branch flowed into create.
    expect(findCall('glab mr create')).toContain('main');
  });

  test('nested GitLab group path is forwarded verbatim and URL-encoded for api lookup (#290)', async () => {
    // Regression guard: the deep group path
    // `analogicdev/internal/tools/blueshift/blueshift-docmancer-ui`
    // (4 `/` levels) was the exact case that motivated #290's regex fix.
    // The adapter must forward the slug verbatim to `-R` and URL-encode
    // every `/` (→ `%2F`) for the api lookup path segment.
    const repo = 'analogicdev/internal/tools/blueshift/blueshift-docmancer-ui';
    on('git branch --show-current', 'feature/nested\n');
    on('glab mr create', 'created\n');
    on(
      'merge_requests?source_branch',
      JSON.stringify([{
        iid: 42,
        web_url: `https://gitlab.com/${repo}/-/merge_requests/42`,
        state: 'opened',
        source_branch: 'feature/nested',
        target_branch: 'main',
      }]),
    );

    const result = await prCreateGitlab({ title: 't', body: 'b', base: 'main', repo });
    expectOk(result);
    expect(result.data.number).toBe(42);

    // `-R` carries the slug verbatim (glab handles URL-encoding for it).
    const create = findCall('glab mr create');
    expect(create).toContain('-R');
    expect(create).toContain(repo);
    // The api lookup path replaces every `/` with `%2F` — 4 `/` →
    // 4 `%2F` in the encoded slug.
    const apiLookup = findCall('merge_requests?source_branch');
    const encoded = repo.replace(/\//g, '%2F');
    expect(apiLookup).toContain(encoded);
    // Belt-and-suspenders: count the encoded separators to make sure no
    // `/` leaked into the api path (which would split the URL segments).
    expect((encoded.match(/%2F/g) ?? []).length).toBe(4);
  });

  test('post-create lookup failure surfaces glab_mr_view_failed (regression guard for soft-fallback)', async () => {
    on('git branch --show-current', 'feature/orphan\n');
    on('glab mr create', 'created\n');
    // Lookup returns empty array — no opened MR found despite create succeeding
    on('merge_requests?source_branch', JSON.stringify([]));

    const result = await prCreateGitlab({ title: 't', body: 'b', base: 'main' });
    expectErr(result);
    expect(result.code).toBe('glab_mr_view_failed');
    expect(result.error).toContain('source_branch=feature/orphan');
    expect(result.error).toContain('verify in the GitLab UI');
  });
});
