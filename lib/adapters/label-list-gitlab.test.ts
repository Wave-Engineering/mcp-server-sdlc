import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { AdapterResult, LabelListResponse } from './types.ts';

// Subprocess-boundary tests for the GitLab label_list adapter (R-15).
// Integration-level coverage (schema validation, handler envelope, cross-platform
// dispatch) stays in tests/label_list.test.ts; this file owns the argv-shape
// assertions that prove the adapter speaks `glab` correctly.
//
// Argv strictness per `lesson_origin_ops_pitfalls.md`: glab takes `--per-page`
// and short `-R` (NOT `--repo`). The stub fails loudly if we regress to the
// gh-style flags.

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
  // Argv strictness — gh-style flags on the glab path means we regressed.
  if (flat.includes('glab label list') && (/--limit/.test(flat) || /--repo\s/.test(flat))) {
    const err = new Error(
      `FAIL: glab label list invoked with gh-style flags — glab uses --per-page/-R`,
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

const { labelListGitlab } = await import('./label-list-gitlab.ts');

function on(match: string, respond: string | (() => string)): void {
  execRegistry.push({ match, respond });
}

function expectOk(
  r: AdapterResult<LabelListResponse>,
): asserts r is { ok: true; data: LabelListResponse } {
  if (!('ok' in r) || !r.ok) {
    throw new Error(`expected ok result, got ${JSON.stringify(r)}`);
  }
}

function expectErr(
  r: AdapterResult<LabelListResponse>,
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

describe('labelListGitlab — subprocess boundary', () => {
  // --- argv: glab label list ---

  test('argv: glab label list default flags', async () => {
    on('glab label list', '[]');

    const result = await labelListGitlab({ limit: 100 });
    expectOk(result);

    const call = findCall('glab label list');
    expect(call).toContain("'-F' 'json'");
    expect(call).toContain("'--per-page' '100'");
    expect(call).not.toContain('-R ');
    // gh-style flags must NOT leak onto the glab path.
    expect(call).not.toContain('--limit');
    expect(call).not.toContain("'--repo'");
  });

  test('argv: forwards --per-page with caller-supplied value', async () => {
    on('glab label list', '[]');

    await labelListGitlab({ limit: 25 });

    const call = findCall('glab label list');
    expect(call).toContain("'--per-page' '25'");
  });

  test('argv: -R flag (not --repo) forwarded for cross-repo list', async () => {
    on('glab label list', '[]');

    await labelListGitlab({ limit: 100, repo: 'foo/bar' });

    const call = findCall('glab label list');
    // glab uses short `-R`, NOT `--repo`.
    expect(call).toContain("'-R' 'foo/bar'");
    expect(call).not.toContain("'--repo'");
  });

  // --- happy path: normalization ---

  test('strips leading # from color — consumers see bare hex', async () => {
    on(
      'glab label list',
      JSON.stringify([
        { name: 'bug', description: 'Bug', color: '#d73a4a' },
        { name: 'enhancement', description: '', color: '#a2eeef' },
      ]),
    );

    const result = await labelListGitlab({ limit: 100 });
    expectOk(result);

    expect(result.data.count).toBe(2);
    expect(result.data.labels[0].color).toBe('d73a4a');
    expect(result.data.labels[1].color).toBe('a2eeef');
  });

  test('fills missing description with empty string', async () => {
    on(
      'glab label list',
      JSON.stringify([{ name: 'bug', color: '#d73a4a' }]),
    );

    const result = await labelListGitlab({ limit: 100 });
    expectOk(result);

    expect(result.data.labels[0].description).toBe('');
  });

  test('tolerates missing color field', async () => {
    on(
      'glab label list',
      JSON.stringify([{ name: 'bug', description: 'x' }]),
    );

    const result = await labelListGitlab({ limit: 100 });
    expectOk(result);

    expect(result.data.labels[0].color).toBe('');
  });

  test('empty list → count 0, labels []', async () => {
    on('glab label list', '[]');

    const result = await labelListGitlab({ limit: 100 });
    expectOk(result);

    expect(result.data.count).toBe(0);
    expect(result.data.labels).toEqual([]);
  });

  // --- error surface ---

  test('returns AdapterResult.error on glab failure (not thrown)', async () => {
    on('glab label list', () => {
      const err = new Error('glab: 401 unauthorized') as ThrowableError;
      err.stderr = 'glab: 401 unauthorized';
      err.status = 1;
      throw err;
    });

    const result = await labelListGitlab({ limit: 100 });
    expectErr(result);
    expect(result.code).toBe('glab_label_list_failed');
    expect(result.error).toContain('glab label list failed');
  });

  test('returns parse error when glab emits non-JSON', async () => {
    on('glab label list', 'not valid json');

    const result = await labelListGitlab({ limit: 100 });
    expectErr(result);
    expect(result.code).toBe('glab_label_list_parse_failed');
  });
});
