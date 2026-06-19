import { describe, test, expect, beforeEach } from 'bun:test';
import type { AdapterResult, LabelListResponse } from './types.ts';
import {
  installChildProcessMock,
  onExec as on,
  resetExecMock,
  execCalls,
} from '../test-support/mock-child-process.ts';

// Subprocess-boundary tests for the GitHub label_list adapter (R-15).
// Integration-level coverage (schema validation, handler envelope, cross-platform
// dispatch) stays in tests/label_list.test.ts; this file owns the argv-shape
// assertions that prove the adapter speaks `gh` correctly.
//
// Argv strictness per `lesson_origin_ops_pitfalls.md`: gh takes `--limit` and
// `--repo` (long flags). The stub fails loudly if we regress.

interface ThrowableError extends Error {
  stderr?: string;
  stdout?: string;
  status?: number;
}

function unquote(cmd: string): string {
  return cmd.replace(/'([^']*)'/g, '$1');
}

installChildProcessMock();

const { labelListGithub } = await import('./label-list-github.ts');

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
  return execCalls().find((c) => c.includes(needle) || unquote(c).includes(needle)) ?? '';
}

beforeEach(() => {
  resetExecMock();
});

describe('labelListGithub — subprocess boundary', () => {
  // --- argv: gh label list ---

  test('argv: gh label list default flags', async () => {
    on('gh label list', '[]');

    const result = await labelListGithub({ limit: 100 });
    expectOk(result);

    const call = findCall('gh label list');
    expect(call).toContain("'--json' 'name,description,color'");
    expect(call).toContain("'--limit' '100'");
    expect(call).not.toContain('--repo');
    // glab-style flags must NOT leak onto the gh path.
    expect(call).not.toContain('--per-page');
    expect(call).not.toContain(' -R ');
    expect(call).not.toContain("'-R'");
  });

  test('argv: forwards --limit with caller-supplied value', async () => {
    on('gh label list', '[]');

    await labelListGithub({ limit: 50 });

    const call = findCall('gh label list');
    expect(call).toContain("'--limit' '50'");
  });

  test('argv: --repo flag forwarded for cross-repo list', async () => {
    on('gh label list', '[]');

    await labelListGithub({ limit: 100, repo: 'other-org/other-repo' });

    const call = findCall('gh label list');
    expect(call).toContain("'--repo' 'other-org/other-repo'");
  });

  test('argv: quotes repo with shell-escape', async () => {
    on('gh label list', '[]');

    await labelListGithub({ limit: 100, repo: "tricky/repo-name" });

    const call = findCall('gh label list');
    // shellEscape wraps in single quotes.
    expect(call).toContain("'tricky/repo-name'");
  });

  // --- happy path: normalization ---

  test('normalizes labels — passes bare-hex color through unchanged', async () => {
    on(
      'gh label list',
      JSON.stringify([
        { name: 'bug', description: 'Something broken', color: 'd73a4a' },
        { name: 'enhancement', description: 'New feature', color: 'a2eeef' },
      ]),
    );

    const result = await labelListGithub({ limit: 100 });
    expectOk(result);

    expect(result.data.count).toBe(2);
    expect(result.data.labels[0]).toEqual({
      name: 'bug',
      description: 'Something broken',
      color: 'd73a4a',
    });
    expect(result.data.labels[1]).toEqual({
      name: 'enhancement',
      description: 'New feature',
      color: 'a2eeef',
    });
  });

  test('fills missing description with empty string', async () => {
    on(
      'gh label list',
      JSON.stringify([{ name: 'bug', color: 'd73a4a' }]),
    );

    const result = await labelListGithub({ limit: 100 });
    expectOk(result);

    expect(result.data.labels[0].description).toBe('');
  });

  test('fills missing color with empty string', async () => {
    on(
      'gh label list',
      JSON.stringify([{ name: 'bug', description: 'x' }]),
    );

    const result = await labelListGithub({ limit: 100 });
    expectOk(result);

    expect(result.data.labels[0].color).toBe('');
  });

  test('empty list → count 0, labels []', async () => {
    on('gh label list', '[]');

    const result = await labelListGithub({ limit: 100 });
    expectOk(result);

    expect(result.data.count).toBe(0);
    expect(result.data.labels).toEqual([]);
  });

  // --- error surface ---

  test('returns AdapterResult.error on gh failure (not thrown)', async () => {
    on('gh label list', () => {
      const err = new Error('gh: not authenticated') as ThrowableError;
      err.stderr = 'gh: not authenticated';
      err.status = 1;
      throw err;
    });

    const result = await labelListGithub({ limit: 100 });
    expectErr(result);
    expect(result.code).toBe('gh_label_list_failed');
    expect(result.error).toContain('gh label list failed');
  });

  test('returns parse error when gh emits non-JSON', async () => {
    on('gh label list', 'not valid json');

    const result = await labelListGithub({ limit: 100 });
    expectErr(result);
    expect(result.code).toBe('gh_label_list_parse_failed');
  });
});
