import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { AdapterResult, PrFilesResponse } from './types.ts';

// Subprocess-boundary tests for the GitLab pr_files adapter (R-15).
// Integration-level coverage stays in tests/pr_files.test.ts. This file
// covers argv-shape, MR-changes parsing, the boolean → status mapping
// table (added/modified/removed/renamed), and parseDiffStats invariants.

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

const { prFilesGitlab, parseDiffStats } = await import('./pr-files-gitlab.ts');

function on(match: string, respond: string | (() => string)): void {
  execRegistry.push({ match, respond });
}

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

describe('prFilesGitlab — subprocess boundary', () => {
  test('glab CLI invocation matches expected argv shape (happy path)', async () => {
    on('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    on(
      'glab api projects/org%2Frepo/merge_requests/3',
      JSON.stringify({
        changes: [
          {
            new_path: 'src/brand-new.ts',
            old_path: 'src/brand-new.ts',
            new_file: true,
            renamed_file: false,
            deleted_file: false,
            diff: '--- /dev/null\n+++ b/src/brand-new.ts\n@@ -0,0 +1,2 @@\n+a\n+b\n',
          },
        ],
      }),
    );

    const result = await prFilesGitlab({ number: 3 });
    expectOk(result);
    expect(result.data.number).toBe(3);

    const call = findCall('glab api projects/');
    expect(call).toContain('merge_requests/3');
    // Slug must be URL-encoded.
    expect(call).toContain('org%2Frepo');
  });

  test('parses MR diffs response into PrFilesResponse with derived stats', async () => {
    on('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    on(
      'glab api projects/org%2Frepo/merge_requests/11',
      JSON.stringify({
        changes: [
          {
            new_path: 'added.ts',
            old_path: 'added.ts',
            new_file: true,
            renamed_file: false,
            deleted_file: false,
            diff: '--- /dev/null\n+++ b/added.ts\n@@ -0,0 +1,2 @@\n+a\n+b\n',
          },
          {
            new_path: 'modified.ts',
            old_path: 'modified.ts',
            new_file: false,
            renamed_file: false,
            deleted_file: false,
            diff: '--- a/modified.ts\n+++ b/modified.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n context\n',
          },
          {
            new_path: 'removed.ts',
            old_path: 'removed.ts',
            new_file: false,
            renamed_file: false,
            deleted_file: true,
            diff: '--- a/removed.ts\n+++ /dev/null\n@@ -1,3 +0,0 @@\n-one\n-two\n-three\n',
          },
          {
            new_path: 'new-name.ts',
            old_path: 'old-name.ts',
            new_file: false,
            renamed_file: true,
            deleted_file: false,
            diff: '',
          },
        ],
      }),
    );

    const result = await prFilesGitlab({ number: 11 });
    expectOk(result);
    expect(result.data.files).toEqual([
      { path: 'added.ts', status: 'added', additions: 2, deletions: 0 },
      { path: 'modified.ts', status: 'modified', additions: 1, deletions: 1 },
      { path: 'removed.ts', status: 'removed', additions: 0, deletions: 3 },
      { path: 'new-name.ts', status: 'renamed', additions: 0, deletions: 0 },
    ]);
    expect(result.data.total_additions).toBe(3);
    expect(result.data.total_deletions).toBe(4);
  });

  test('renamed file with diff still counts hunk stats', async () => {
    on('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    on(
      'glab api projects/org%2Frepo/merge_requests/15',
      JSON.stringify({
        changes: [
          {
            new_path: 'b.ts',
            old_path: 'a.ts',
            new_file: false,
            renamed_file: true,
            deleted_file: false,
            diff: '--- a/a.ts\n+++ b/b.ts\n@@ -1,2 +1,3 @@\n existing\n-old\n+new\n+extra\n',
          },
        ],
      }),
    );

    const result = await prFilesGitlab({ number: 15 });
    expectOk(result);
    expect(result.data.files[0]).toEqual({
      path: 'b.ts',
      status: 'renamed',
      additions: 2,
      deletions: 1,
    });
  });

  test('falls back to old_path when new_path absent (deleted file)', async () => {
    on('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    on(
      'glab api projects/org%2Frepo/merge_requests/4',
      JSON.stringify({
        changes: [
          {
            old_path: 'gone.ts',
            new_file: false,
            renamed_file: false,
            deleted_file: true,
            diff: '--- a/gone.ts\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-x\n',
          },
        ],
      }),
    );

    const result = await prFilesGitlab({ number: 4 });
    expectOk(result);
    expect(result.data.files[0].path).toBe('gone.ts');
    expect(result.data.files[0].status).toBe('removed');
  });

  test('missing changes field returns empty list and zero totals', async () => {
    on('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    on('glab api projects/org%2Frepo/merge_requests/50', JSON.stringify({}));

    const result = await prFilesGitlab({ number: 50 });
    expectOk(result);
    expect(result.data.files).toEqual([]);
    expect(result.data.total_additions).toBe(0);
    expect(result.data.total_deletions).toBe(0);
  });

  test('returns AdapterResult{ok:false, code} on glab failure (not thrown)', async () => {
    on('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    on('glab api projects/org%2Frepo/merge_requests/77', () => {
      const err = new Error('glab: not authenticated') as ThrowableError;
      err.stderr = 'glab: not authenticated';
      err.status = 1;
      throw err;
    });

    const result = await prFilesGitlab({ number: 77 });
    expectErr(result);
    expect(result.code).toBe('unexpected_error');
    expect(result.error).toContain('glab');
  });

  test('args.repo slug routed into glab api path (URL-encoded), overriding cwd remote', async () => {
    on('git remote get-url origin', 'https://gitlab.com/cwd-org/cwd-repo.git');
    on(
      'glab api projects/target-org%2Ftarget-repo/merge_requests/8',
      JSON.stringify({ changes: [] }),
    );

    const result = await prFilesGitlab({ number: 8, repo: 'target-org/target-repo' });
    expectOk(result);

    const call = findCall('glab api projects/');
    expect(call).toContain('target-org%2Ftarget-repo');
    expect(call).not.toContain('cwd-org%2Fcwd-repo');
  });
});

describe('parseDiffStats helper', () => {
  test('empty diff returns zeros', () => {
    expect(parseDiffStats('')).toEqual({ additions: 0, deletions: 0 });
  });

  test('counts additions and deletions ignoring +++/--- headers and context', () => {
    const diff = [
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -1,3 +1,4 @@',
      ' context',
      '-removed',
      '+added 1',
      '+added 2',
      ' more context',
    ].join('\n');
    expect(parseDiffStats(diff)).toEqual({ additions: 2, deletions: 1 });
  });

  test('multiple file blocks aggregate correctly', () => {
    const diff = [
      '--- a/one.ts',
      '+++ b/one.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '--- a/two.ts',
      '+++ b/two.ts',
      '@@ -0,0 +1 @@',
      '+added',
    ].join('\n');
    expect(parseDiffStats(diff)).toEqual({ additions: 2, deletions: 1 });
  });
});
