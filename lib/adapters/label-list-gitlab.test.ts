import { describe, test, expect, beforeEach } from 'bun:test';
import type { AdapterResult, LabelListResponse } from './types.ts';
import {
  installChildProcessMock,
  onExec as on,
  resetExecMock,
  execCalls,
} from '../test-support/mock-child-process.ts';

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

function unquote(cmd: string): string {
  return cmd.replace(/'([^']*)'/g, '$1');
}

installChildProcessMock();

const { labelListGitlab } = await import('./label-list-gitlab.ts');

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

describe('labelListGitlab — subprocess boundary', () => {
  // --- argv: glab api projects/<id>/labels (#594) ---
  // `glab label list -F json` needs glab >= 1.37.0, one release above the
  // documented 1.36.0 floor, so the adapter reads the REST endpoint instead.

  test('argv: glab api on the current project, no output flags', async () => {
    on('/labels?per_page=', '[]');

    const result = await labelListGitlab({ limit: 100 });
    expectOk(result);

    const call = unquote(findCall('/labels?per_page='));
    expect(call).toBe('glab api projects/:id/labels?per_page=100');
    // Neither glab's view/list output flags nor gh-style flags.
    expect(call).not.toContain('-F');
    expect(call).not.toContain('--per-page');
    expect(call).not.toContain('--limit');
    expect(call).not.toContain('--repo');
  });

  test('argv: forwards the caller-supplied limit as per_page', async () => {
    on('/labels?per_page=', '[]');

    await labelListGitlab({ limit: 25 });

    expect(unquote(findCall('/labels?per_page='))).toBe(
      'glab api projects/:id/labels?per_page=25',
    );
  });

  test('argv: a cross-repo list addresses the URL-encoded project path', async () => {
    on('/labels?per_page=', '[]');

    await labelListGitlab({ limit: 100, repo: 'group/sub/bar' });

    expect(unquote(findCall('/labels?per_page='))).toBe(
      'glab api projects/group%2Fsub%2Fbar/labels?per_page=100',
    );
  });

  // --- happy path: normalization ---

  test('strips leading # from color — consumers see bare hex', async () => {
    on(
      '/labels?per_page=',
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
      '/labels?per_page=',
      JSON.stringify([{ name: 'bug', color: '#d73a4a' }]),
    );

    const result = await labelListGitlab({ limit: 100 });
    expectOk(result);

    expect(result.data.labels[0].description).toBe('');
  });

  test('tolerates missing color field', async () => {
    on(
      '/labels?per_page=',
      JSON.stringify([{ name: 'bug', description: 'x' }]),
    );

    const result = await labelListGitlab({ limit: 100 });
    expectOk(result);

    expect(result.data.labels[0].color).toBe('');
  });

  test('empty list → count 0, labels []', async () => {
    on('/labels?per_page=', '[]');

    const result = await labelListGitlab({ limit: 100 });
    expectOk(result);

    expect(result.data.count).toBe(0);
    expect(result.data.labels).toEqual([]);
  });

  // --- error surface ---

  test('returns AdapterResult.error on glab failure (not thrown)', async () => {
    on('/labels?per_page=', () => {
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

  test('an HTTP error body on exit 0 is a failure, not a label list (#502)', async () => {
    // `glab api` prints the error body and exits 0 on the 1.36.0 floor.
    on('/labels?per_page=', '{"message":"404 Project Not Found"}');

    const result = await labelListGitlab({ limit: 100, repo: 'foo/missing' });
    expectErr(result);
    expect(result.code).toBe('glab_label_list_failed');
    expect(result.error).toContain('404 Project Not Found');
  });

  test('returns parse error when glab emits non-JSON', async () => {
    on('/labels?per_page=', 'not valid json');

    const result = await labelListGitlab({ limit: 100 });
    expectErr(result);
    expect(result.code).toBe('glab_label_list_parse_failed');
  });
});
