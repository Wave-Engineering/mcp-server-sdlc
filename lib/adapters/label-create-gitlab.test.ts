import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { AdapterResult, NormalizedLabel } from './types.ts';

// Subprocess-boundary tests for the GitLab label_create adapter (R-15).
// Integration-level coverage (schema validation, handler envelope, cross-platform
// dispatch) stays in tests/label_create.test.ts; this file owns the argv-shape
// assertions that prove the adapter speaks `glab` correctly.
//
// Color format strictness — GitLab REST API REQUIRES leading `#RRGGBB`; bare
// hex is rejected. The stub fails loudly if we forget and emit `--color 'd73a4a'`
// on the GitLab side (per `lesson_origin_ops_pitfalls.md`).

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
  // Argv strictness — bare-hex color on the glab path means we regressed.
  // Fail LOUDLY rather than let the test silently pass.
  if (flat.includes('glab label create') && /--color [0-9a-fA-F]{6}/.test(flat)) {
    const err = new Error(
      `FAIL: glab label create invoked with bare-hex color — GitLab requires leading '#'`,
    ) as ThrowableError;
    err.status = 127;
    throw err;
  }
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

const { labelCreateGitlab } = await import('./label-create-gitlab.ts');

function on(match: string, respond: string | (() => string)): void {
  execRegistry.push({ match, respond });
}

function expectOk(
  r: AdapterResult<NormalizedLabel>,
): asserts r is { ok: true; data: NormalizedLabel } {
  if (!('ok' in r) || !r.ok) {
    throw new Error(`expected ok result, got ${JSON.stringify(r)}`);
  }
}

function expectErr(
  r: AdapterResult<NormalizedLabel>,
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

describe('labelCreateGitlab — subprocess boundary', () => {
  // --- argv: glab label create (leading-# color) ---

  test('argv: glab api ... (leading-# color)', async () => {
    on('glab label create', '');

    const result = await labelCreateGitlab({
      name: 'priority::high',
      color: 'd73a4a',
      description: 'Top priority',
    });
    expectOk(result);

    const call = findCall('glab label create');
    // --name is a flag, not positional, on the glab path.
    expect(call).toContain("'--name' 'priority::high'");
    // Leading `#` prepended — GitLab REST API rejects bare hex.
    expect(call).toContain("'--color' '#d73a4a'");
    expect(call).not.toContain("'--color' 'd73a4a'");
    expect(call).toContain("'--description' 'Top priority'");
  });

  test('argv: omits --color when color not provided', async () => {
    on('glab label create', '');

    const result = await labelCreateGitlab({ name: 'bug' });
    expectOk(result);

    const call = findCall('glab label create');
    expect(call).not.toContain('--color');
  });

  test('argv: omits --description when description empty', async () => {
    on('glab label create', '');

    await labelCreateGitlab({ name: 'bug', color: 'd73a4a' });

    const call = findCall('glab label create');
    expect(call).not.toContain('--description');
  });

  test('argv: -R flag (not --repo) forwarded for cross-repo create', async () => {
    on('glab label create', '');

    await labelCreateGitlab({ name: 'bug', color: 'd73a4a', repo: 'foo/bar' });

    const call = findCall('glab label create');
    // glab uses short `-R`, NOT `--repo`.
    expect(call).toContain("'-R' 'foo/bar'");
    expect(call).not.toContain('--repo');
  });

  test('argv: quotes name with shell-escape', async () => {
    on('glab label create', '');

    await labelCreateGitlab({ name: "needs-review's-input", color: 'd73a4a' });

    const call = findCall('glab label create');
    expect(call).toContain(`'needs-review'\\''s-input'`);
  });

  // --- happy path: creates new label ---

  test('creates new label — returns created:true with caller-requested fields', async () => {
    on('glab label create', '');

    const result = await labelCreateGitlab({
      name: 'priority::high',
      color: 'd73a4a',
      description: 'Top priority',
    });
    expectOk(result);

    // Response mirrors caller input (bare hex) — the `#` only exists on-wire.
    expect(result.data).toEqual({
      name: 'priority::high',
      description: 'Top priority',
      color: 'd73a4a',
      created: true,
    });
  });

  // --- duplicate-lookup fallback ---

  test('duplicate-lookup fallback', async () => {
    on('glab label create', () => {
      const err = new Error('label already exists') as ThrowableError;
      err.stderr = 'Label already exists\n';
      err.status = 1;
      throw err;
    });
    on(
      'glab label list',
      JSON.stringify([{ name: 'bug', description: 'pre-existing', color: '#aabbcc' }]),
    );

    const result = await labelCreateGitlab({
      name: 'bug',
      description: 'ignored',
      color: 'd73a4a',
    });
    expectOk(result);

    // `#` stripped — consumers always see bare hex.
    expect(result.data).toEqual({
      name: 'bug',
      description: 'pre-existing',
      color: 'aabbcc',
      created: false,
    });

    // Lookup argv: -F json --per-page 100
    const lookupCall = findCall('glab label list');
    expect(lookupCall).toContain("'-F' 'json'");
    expect(lookupCall).toContain("'--per-page' '100'");
  });

  test('duplicate-lookup forwards -R on the lookup call too', async () => {
    on('glab label create', () => {
      const err = new Error('already exists') as ThrowableError;
      err.stderr = 'Label already exists\n';
      err.status = 1;
      throw err;
    });
    on(
      'glab label list',
      JSON.stringify([{ name: 'bug', description: '', color: '#aabbcc' }]),
    );

    await labelCreateGitlab({ name: 'bug', color: 'd73a4a', repo: 'foo/bar' });

    const lookupCall = findCall('glab label list');
    expect(lookupCall).toContain("'-R' 'foo/bar'");
  });

  test('duplicate lookup misses → ok:false with glab_label_lookup_failed code', async () => {
    on('glab label create', () => {
      const err = new Error('already exists') as ThrowableError;
      err.stderr = 'Label already exists\n';
      err.status = 1;
      throw err;
    });
    on('glab label list', JSON.stringify([])); // lookup returns no matches

    const result = await labelCreateGitlab({ name: 'bug', color: 'd73a4a' });
    expectErr(result);
    expect(result.code).toBe('glab_label_lookup_failed');
  });

  // --- error surface ---

  test('returns AdapterResult.error on non-duplicate glab failure (not thrown)', async () => {
    on('glab label create', () => {
      const err = new Error('glab: 401 unauthorized') as ThrowableError;
      err.stderr = 'glab: 401 unauthorized';
      err.status = 1;
      throw err;
    });

    const result = await labelCreateGitlab({ name: 'bug', color: 'd73a4a' });
    expectErr(result);
    expect(result.code).toBe('glab_label_create_failed');
    expect(result.error).toContain('glab label create failed');
  });
});
