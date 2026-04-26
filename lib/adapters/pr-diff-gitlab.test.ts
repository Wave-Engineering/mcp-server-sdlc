import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { AdapterResult, PrDiffResponse } from './types.ts';

// Subprocess-boundary tests for the GitLab pr_diff adapter (R-15).
// Integration-level coverage stays in tests/pr_diff.test.ts.

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

const { prDiffGitlab } = await import('./pr-diff-gitlab.ts');

function on(match: string, respond: string | (() => string)): void {
  execRegistry.push({ match, respond });
}

function expectOk(
  r: AdapterResult<PrDiffResponse>,
): asserts r is { ok: true; data: PrDiffResponse } {
  if (!('ok' in r) || !r.ok) {
    throw new Error(`expected ok result, got ${JSON.stringify(r)}`);
  }
}

function expectErr(
  r: AdapterResult<PrDiffResponse>,
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

const TWO_FILE_DIFF = `diff --git a/foo.txt b/foo.txt
index 1234567..89abcde 100644
--- a/foo.txt
+++ b/foo.txt
@@ -1,1 +1,1 @@
-old
+new
diff --git a/bar.txt b/bar.txt
index abcdef0..fedcba9 100644
--- a/bar.txt
+++ b/bar.txt
@@ -1,1 +1,1 @@
-foo
+bar
`;

function buildHugeDiff(lineCount: number): string {
  const parts: string[] = ['diff --git a/big.txt b/big.txt'];
  parts.push('index 1234567..89abcde 100644');
  parts.push('--- a/big.txt');
  parts.push('+++ b/big.txt');
  parts.push(`@@ -1,${lineCount - 4} +1,${lineCount - 4} @@`);
  for (let i = 0; i < lineCount - 5; i++) {
    parts.push(`+line ${i}`);
  }
  return parts.join('\n') + '\n';
}

describe('prDiffGitlab — subprocess boundary', () => {
  test('glab CLI invocation matches expected argv shape (happy path)', async () => {
    on('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    on('glab mr diff', TWO_FILE_DIFF);
    on(
      'glab api projects/org%2Frepo/merge_requests/11',
      JSON.stringify({
        iid: 11,
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/11',
        title: 't',
        description: '',
        state: 'opened',
        source_branch: 's',
        target_branch: 'main',
        labels: [],
      }),
    );

    const result = await prDiffGitlab({ number: 11 });
    expectOk(result);
    expect(result.data.number).toBe(11);

    const diffCall = findCall('glab mr diff');
    expect(diffCall).toContain('11');
    // No --repo absent an explicit slug.
    expect(diffCall).not.toContain('--repo');
  });

  test('parses unified diff response into PrDiffResponse', async () => {
    on('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    on('glab mr diff', TWO_FILE_DIFF);
    on(
      'glab api projects/org%2Frepo/merge_requests/11',
      JSON.stringify({
        iid: 11,
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/11',
        title: 't',
        description: '',
        state: 'opened',
        source_branch: 's',
        target_branch: 'main',
        labels: [],
      }),
    );

    const result = await prDiffGitlab({ number: 11 });
    expectOk(result);
    expect(result.data).toEqual({
      number: 11,
      diff: TWO_FILE_DIFF,
      line_count: 14,
      file_count: 2,
      url: 'https://gitlab.com/org/repo/-/merge_requests/11',
      truncated: false,
    });
  });

  test('returns AdapterResult{ok:false, code} on glab mr diff failure (not thrown)', async () => {
    on('glab mr diff', () => {
      const err = new Error('glab: not authenticated') as ThrowableError;
      err.stderr = 'glab: not authenticated';
      err.status = 1;
      throw err;
    });

    const result = await prDiffGitlab({ number: 11 });
    expectErr(result);
    expect(result.code).toBe('glab_mr_diff_failed');
    expect(result.error).toContain('glab mr diff failed');
  });

  test('handles 10000-line truncation safety valve', async () => {
    const huge = buildHugeDiff(20000);
    on('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    on('glab mr diff', huge);
    on(
      'glab api projects/org%2Frepo/merge_requests/500',
      JSON.stringify({
        iid: 500,
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/500',
        title: 't',
        description: '',
        state: 'opened',
        source_branch: 's',
        target_branch: 'main',
        labels: [],
      }),
    );

    const result = await prDiffGitlab({ number: 500 });
    expectOk(result);
    expect(result.data.truncated).toBe(true);
    expect(result.data.diff).toContain('lines omitted');
    expect(result.data.diff.startsWith('diff --git a/big.txt b/big.txt')).toBe(true);
    expect(result.data.diff.split('\n').length).toBeLessThan(huge.split('\n').length);
    expect(result.data.line_count).toBeGreaterThan(10000);
    expect(result.data.line_count).toBeLessThan(10010);
  });

  test('empty diff returns zero counts', async () => {
    on('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    on('glab mr diff', '');
    on(
      'glab api projects/org%2Frepo/merge_requests/22',
      JSON.stringify({
        iid: 22,
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/22',
        title: 't',
        description: '',
        state: 'opened',
        source_branch: 's',
        target_branch: 'main',
        labels: [],
      }),
    );

    const result = await prDiffGitlab({ number: 22 });
    expectOk(result);
    expect(result.data.diff).toBe('');
    expect(result.data.line_count).toBe(0);
    expect(result.data.file_count).toBe(0);
  });

  test('--repo flag forwarded into glab mr diff and slug routed into glab api path', async () => {
    on('git remote get-url origin', 'https://gitlab.com/cwd-org/cwd-repo.git');
    on('glab mr diff', TWO_FILE_DIFF);
    on(
      'glab api projects/target-org%2Ftarget-repo/merge_requests/11',
      JSON.stringify({
        iid: 11,
        web_url: 'https://gitlab.com/target-org/target-repo/-/merge_requests/11',
        title: 't',
        description: '',
        state: 'opened',
        source_branch: 's',
        target_branch: 'main',
        labels: [],
      }),
    );

    const result = await prDiffGitlab({ number: 11, repo: 'target-org/target-repo' });
    expectOk(result);
    const diff = findCall('glab mr diff');
    expect(diff).toContain('--repo');
    expect(diff).toContain('target-org/target-repo');
    const api = findCall('glab api projects/');
    expect(api).toContain('target-org%2Ftarget-repo');
    expect(api).not.toContain('cwd-org%2Fcwd-repo');
  });
});
