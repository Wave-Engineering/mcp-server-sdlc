import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { AdapterResult, NormalizedLabel } from './types.ts';

// Subprocess-boundary tests for the GitHub label_create adapter (R-15).
// Integration-level coverage (schema validation, handler envelope, cross-platform
// dispatch) stays in tests/label_create.test.ts; this file owns the argv-shape
// assertions that prove the adapter speaks `gh` correctly.
//
// Color format strictness — gh accepts BARE 6-char hex (no leading `#`).
// The stub fails loudly if we forget and emit `--color '#d73a4a'` on the
// GitHub side (per `lesson_origin_ops_pitfalls.md`).

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
  // Argv strictness — leading-# color on the gh path means we regressed.
  // Fail LOUDLY rather than let the test silently pass.
  if (flat.includes("gh label create") && flat.includes("--color #")) {
    const err = new Error(
      `FAIL: gh label create invoked with leading-# color — gh requires BARE hex`,
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

const { labelCreateGithub } = await import('./label-create-github.ts');

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

describe('labelCreateGithub — subprocess boundary', () => {
  // --- argv: gh label create (bare-hex color) ---

  test('argv: gh label create (bare-hex color)', async () => {
    on('gh label create', '');

    const result = await labelCreateGithub({
      name: 'priority::high',
      color: 'd73a4a',
      description: 'Top priority',
    });
    expectOk(result);

    const call = findCall('gh label create');
    expect(call).toContain('priority::high');
    // Bare hex — no leading `#` on the gh path.
    expect(call).toContain("'--color' 'd73a4a'");
    expect(call).not.toContain("'#d73a4a'");
    expect(call).toContain("'--description' 'Top priority'");
  });

  test('argv: omits --color when color not provided', async () => {
    on('gh label create', '');

    const result = await labelCreateGithub({ name: 'bug' });
    expectOk(result);

    const call = findCall('gh label create');
    expect(call).not.toContain('--color');
  });

  test('argv: omits --description when description empty', async () => {
    on('gh label create', '');

    await labelCreateGithub({ name: 'bug', color: 'd73a4a' });

    const call = findCall('gh label create');
    expect(call).not.toContain('--description');
  });

  test('argv: --repo flag forwarded for cross-repo create', async () => {
    on('gh label create', '');

    await labelCreateGithub({ name: 'bug', color: 'd73a4a', repo: 'other-org/other-repo' });

    const call = findCall('gh label create');
    expect(call).toContain("'--repo' 'other-org/other-repo'");
  });

  test('argv: quotes name with shell-escape', async () => {
    on('gh label create', '');

    await labelCreateGithub({ name: "needs-review's-input", color: 'd73a4a' });

    const call = findCall('gh label create');
    expect(call).toContain(`'needs-review'\\''s-input'`);
  });

  // --- happy path: creates new label ---

  test('creates new label — returns created:true with caller-requested fields', async () => {
    on('gh label create', '');

    const result = await labelCreateGithub({
      name: 'priority::high',
      color: 'd73a4a',
      description: 'Top priority',
    });
    expectOk(result);

    expect(result.data).toEqual({
      name: 'priority::high',
      description: 'Top priority',
      color: 'd73a4a',
      created: true,
    });
  });

  // --- duplicate-lookup fallback ---

  test('duplicate-lookup fallback on "already exists"', async () => {
    on('gh label create', () => {
      const err = new Error('label already exists') as ThrowableError;
      err.stderr = '! Label "bug" already exists\n';
      err.status = 1;
      throw err;
    });
    on(
      'gh label list',
      JSON.stringify([{ name: 'bug', description: 'pre-existing', color: 'aabbcc' }]),
    );

    const result = await labelCreateGithub({
      name: 'bug',
      description: 'requested (ignored)',
      color: 'd73a4a',
    });
    expectOk(result);

    // Returned values reflect what's on the platform, not what we asked for.
    expect(result.data).toEqual({
      name: 'bug',
      description: 'pre-existing',
      color: 'aabbcc',
      created: false,
    });

    // Lookup argv: --search <name>, --json, --limit 20.
    const lookupCall = findCall('gh label list');
    expect(lookupCall).toContain("'--search' 'bug'");
    expect(lookupCall).toContain('--json');
    expect(lookupCall).toContain('name,description,color');
    expect(lookupCall).toContain("'--limit' '20'");
  });

  test('duplicate-lookup forwards --repo on the lookup call too', async () => {
    on('gh label create', () => {
      const err = new Error('already exists') as ThrowableError;
      err.stderr = 'Label already exists\n';
      err.status = 1;
      throw err;
    });
    on(
      'gh label list',
      JSON.stringify([{ name: 'bug', description: '', color: 'aabbcc' }]),
    );

    await labelCreateGithub({ name: 'bug', color: 'd73a4a', repo: 'foo/bar' });

    const lookupCall = findCall('gh label list');
    expect(lookupCall).toContain("'--repo' 'foo/bar'");
  });

  test('duplicate detection is case-insensitive (Already Exists)', async () => {
    on('gh label create', () => {
      const err = new Error('') as ThrowableError;
      err.stderr = 'Label Already Exists in repo\n';
      err.status = 1;
      throw err;
    });
    on(
      'gh label list',
      JSON.stringify([{ name: 'bug', description: '', color: '' }]),
    );

    const result = await labelCreateGithub({ name: 'bug', color: 'd73a4a' });
    expectOk(result);
    expect(result.data.created).toBe(false);
  });

  test('duplicate detection also matches against stdout', async () => {
    on('gh label create', () => {
      const err = new Error('') as ThrowableError;
      err.stdout = 'label already exists\n';
      err.stderr = '';
      err.status = 1;
      throw err;
    });
    on(
      'gh label list',
      JSON.stringify([{ name: 'bug', description: '', color: '' }]),
    );

    const result = await labelCreateGithub({ name: 'bug', color: 'd73a4a' });
    expectOk(result);
    expect(result.data.created).toBe(false);
  });

  test('duplicate lookup misses → ok:false with gh_label_lookup_failed code', async () => {
    on('gh label create', () => {
      const err = new Error('already exists') as ThrowableError;
      err.stderr = 'Label already exists\n';
      err.status = 1;
      throw err;
    });
    on('gh label list', JSON.stringify([])); // lookup returns no matches

    const result = await labelCreateGithub({ name: 'bug', color: 'd73a4a' });
    expectErr(result);
    expect(result.code).toBe('gh_label_lookup_failed');
  });

  // --- error surface ---

  test('returns AdapterResult.error on non-duplicate gh failure (not thrown)', async () => {
    on('gh label create', () => {
      const err = new Error('gh: not authenticated') as ThrowableError;
      err.stderr = 'gh: not authenticated';
      err.status = 1;
      throw err;
    });

    const result = await labelCreateGithub({ name: 'bug', color: 'd73a4a' });
    expectErr(result);
    expect(result.code).toBe('gh_label_create_failed');
    expect(result.error).toContain('gh label create failed');
  });
});
