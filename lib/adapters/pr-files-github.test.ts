import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { AdapterResult, PrFilesResponse } from './types.ts';

// Subprocess-boundary tests for the GitHub pr_files adapter (R-15).
// Integration-level coverage (handler dispatch, error envelope) stays in
// tests/pr_files.test.ts; this file owns the argv-shape and response-parsing
// assertions that prove the adapter speaks `gh` correctly, plus the
// changeType → status mapping table.

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

const { prFilesGithub } = await import('./pr-files-github.ts');

function on(match: string, respond: string | (() => string)): void {
  execRegistry.push({ match, respond });
}

// Narrow AdapterResult into the success branch — throws if it's an error or
// platform_unsupported variant. Lets test bodies access `.data` directly
// without nested `if ('ok' in r && r.ok)` ceremony at every assertion.
function expectOk(
  r: AdapterResult<PrFilesResponse>,
): asserts r is { ok: true; data: PrFilesResponse } {
  if (!('ok' in r) || !r.ok) {
    throw new Error(`expected ok result, got ${JSON.stringify(r)}`);
  }
}

function expectErr(
  r: AdapterResult<PrFilesResponse>,
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

describe('prFilesGithub — subprocess boundary', () => {
  test('gh CLI invocation matches expected argv shape (happy path)', async () => {
    on(
      'gh pr view',
      JSON.stringify({
        files: [{ path: 'src/new.ts', additions: 12, deletions: 0, changeType: 'ADDED' }],
      }),
    );

    const result = await prFilesGithub({ number: 10 });
    expectOk(result);

    const call = findCall('gh pr view');
    expect(call).toContain('10');
    expect(call).toContain('--json');
    expect(call).toContain('files');
    // No --repo flag absent an explicit slug.
    expect(call).not.toContain('--repo');
  });

  test('parses files-changed JSON response into PrFilesResponse', async () => {
    on(
      'gh pr view',
      JSON.stringify({
        files: [
          { path: 'a.ts', additions: 5, deletions: 0, changeType: 'ADDED' },
          { path: 'b.ts', additions: 3, deletions: 2, changeType: 'MODIFIED' },
          { path: 'c.ts', additions: 0, deletions: 7, changeType: 'REMOVED' },
          { path: 'd.ts', additions: 1, deletions: 1, changeType: 'RENAMED' },
        ],
      }),
    );

    const result = await prFilesGithub({ number: 42 });
    expectOk(result);
    expect(result.data).toEqual({
      number: 42,
      files: [
        { path: 'a.ts', status: 'added', additions: 5, deletions: 0 },
        { path: 'b.ts', status: 'modified', additions: 3, deletions: 2 },
        { path: 'c.ts', status: 'removed', additions: 0, deletions: 7 },
        { path: 'd.ts', status: 'renamed', additions: 1, deletions: 1 },
      ],
      total_additions: 9,
      total_deletions: 10,
    });
  });

  test('changeType mapping covers DELETED → removed and CHANGED → modified', async () => {
    on(
      'gh pr view',
      JSON.stringify({
        files: [
          { path: 'gone.ts', additions: 0, deletions: 4, changeType: 'DELETED' },
          { path: 'tweaked.ts', additions: 2, deletions: 1, changeType: 'CHANGED' },
          { path: 'mystery.ts', additions: 1, deletions: 0, changeType: 'WHATEVER' },
        ],
      }),
    );

    const result = await prFilesGithub({ number: 5 });
    expectOk(result);
    expect(result.data.files.map((f) => f.status)).toEqual([
      'removed',
      'modified',
      'modified',
    ]);
  });

  test('empty files list returns empty array and zero totals', async () => {
    on('gh pr view', JSON.stringify({ files: [] }));

    const result = await prFilesGithub({ number: 99 });
    expectOk(result);
    expect(result.data.files).toEqual([]);
    expect(result.data.total_additions).toBe(0);
    expect(result.data.total_deletions).toBe(0);
  });

  test('missing files field defaults to empty list', async () => {
    on('gh pr view', JSON.stringify({}));

    const result = await prFilesGithub({ number: 1 });
    expectOk(result);
    expect(result.data.files).toEqual([]);
  });

  test('non-numeric additions/deletions coerce to 0', async () => {
    on(
      'gh pr view',
      JSON.stringify({
        files: [
          { path: 'weird.ts', additions: 'oops', deletions: null, changeType: 'MODIFIED' },
        ],
      }),
    );

    const result = await prFilesGithub({ number: 3 });
    expectOk(result);
    expect(result.data.files[0]).toEqual({
      path: 'weird.ts',
      status: 'modified',
      additions: 0,
      deletions: 0,
    });
  });

  test('returns AdapterResult{ok:false, code} on gh failure (not thrown)', async () => {
    on('gh pr view', () => {
      const err = new Error('gh: not found') as ThrowableError;
      err.stderr = 'gh: not found';
      err.status = 1;
      throw err;
    });

    const result = await prFilesGithub({ number: 404 });
    expectErr(result);
    expect(result.code).toBe('gh_pr_view_failed');
    expect(result.error).toContain('gh pr view failed');
  });

  test('--repo flag forwarded when args.repo provided', async () => {
    on(
      'gh pr view',
      JSON.stringify({
        files: [{ path: 'x.ts', additions: 1, deletions: 0, changeType: 'ADDED' }],
      }),
    );

    await prFilesGithub({ number: 7, repo: 'Org/Other' });
    const call = findCall('gh pr view');
    expect(call).toContain('--repo');
    expect(call).toContain('Org/Other');
  });
});
