import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { AdapterResult, PrDiffResponse } from './types.ts';

// Subprocess-boundary tests for the GitHub pr_diff adapter (R-15).
// Integration-level coverage (handler dispatch, error envelope) stays in
// tests/pr_diff.test.ts; this file owns the argv-shape and response-parsing
// assertions that prove the adapter speaks `gh` correctly, plus the
// 10000-line truncation safety-valve.

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

const { prDiffGithub } = await import('./pr-diff-github.ts');

function on(match: string, respond: string | (() => string)): void {
  execRegistry.push({ match, respond });
}

// Narrow AdapterResult into the success branch — throws if it's an error or
// platform_unsupported variant. Lets test bodies access `.data` directly
// without nested `if ('ok' in r && r.ok)` ceremony at every assertion.
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

describe('prDiffGithub — subprocess boundary', () => {
  test('gh CLI invocation matches expected argv shape (happy path)', async () => {
    on('gh pr diff', TWO_FILE_DIFF);
    on(
      'gh pr view',
      JSON.stringify({ url: 'https://github.com/org/repo/pull/42' }),
    );

    const result = await prDiffGithub({ number: 42 });

    expectOk(result);
    expect(result.data.number).toBe(42);

    const diffCall = findCall('gh pr diff');
    expect(diffCall).toContain('42');
    // No --repo flag absent an explicit slug.
    expect(diffCall).not.toContain('--repo');

    const viewCall = findCall('gh pr view');
    expect(viewCall).toContain('42');
    expect(viewCall).toContain('--json');
    expect(viewCall).toContain('url');
  });

  test('parses unified diff response into PrDiffResponse', async () => {
    on('gh pr diff', TWO_FILE_DIFF);
    on(
      'gh pr view',
      JSON.stringify({ url: 'https://github.com/org/repo/pull/42' }),
    );

    const result = await prDiffGithub({ number: 42 });
    expectOk(result);
    expect(result.data).toEqual({
      number: 42,
      diff: TWO_FILE_DIFF,
      line_count: 14,
      file_count: 2,
      url: 'https://github.com/org/repo/pull/42',
      truncated: false,
    });
  });

  test('returns AdapterResult{ok:false, code} on gh pr diff failure (not thrown)', async () => {
    on('gh pr diff', () => {
      const err = new Error('gh: auth required') as ThrowableError;
      err.stderr = 'gh: auth required';
      err.status = 4;
      throw err;
    });

    const result = await prDiffGithub({ number: 42 });
    expectErr(result);
    expect(result.code).toBe('gh_pr_diff_failed');
    expect(result.error).toContain('gh pr diff failed');
  });

  test('returns AdapterResult{ok:false, code} on gh pr view failure (not thrown)', async () => {
    on('gh pr diff', TWO_FILE_DIFF);
    on('gh pr view', () => {
      const err = new Error('gh: not found') as ThrowableError;
      err.stderr = 'gh: not found';
      err.status = 1;
      throw err;
    });

    const result = await prDiffGithub({ number: 42 });
    expectErr(result);
    expect(result.code).toBe('gh_pr_view_failed');
    expect(result.error).toContain('gh pr view failed');
  });

  test('handles 10000-line truncation safety valve', async () => {
    const huge = buildHugeDiff(20000);
    on('gh pr diff', huge);
    on(
      'gh pr view',
      JSON.stringify({ url: 'https://github.com/org/repo/pull/500' }),
    );

    const result = await prDiffGithub({ number: 500 });
    expectOk(result);
    expect(result.data.truncated).toBe(true);
    // Must contain the omission marker.
    expect(result.data.diff).toContain('lines omitted');
    // Must preserve the head.
    expect(result.data.diff.startsWith('diff --git a/big.txt b/big.txt')).toBe(true);
    // Truncated diff must be dramatically smaller than the original.
    expect(result.data.diff.split('\n').length).toBeLessThan(huge.split('\n').length);
    // Roughly 10000 content lines + 1 omission marker.
    expect(result.data.line_count).toBeGreaterThan(10000);
    expect(result.data.line_count).toBeLessThan(10010);
  });

  test('exactly 10000 lines is NOT truncated (at-threshold regression)', async () => {
    const atLimit = buildHugeDiff(10000);
    on('gh pr diff', atLimit);
    on(
      'gh pr view',
      JSON.stringify({ url: 'https://github.com/org/repo/pull/123' }),
    );

    const result = await prDiffGithub({ number: 123 });
    expectOk(result);
    expect(result.data.truncated).toBe(false);
    expect(result.data.diff).toBe(atLimit);
  });

  test('empty diff returns zero counts', async () => {
    on('gh pr diff', '');
    on(
      'gh pr view',
      JSON.stringify({ url: 'https://github.com/org/repo/pull/99' }),
    );

    const result = await prDiffGithub({ number: 99 });
    expectOk(result);
    expect(result.data.diff).toBe('');
    expect(result.data.line_count).toBe(0);
    expect(result.data.file_count).toBe(0);
    expect(result.data.truncated).toBe(false);
  });

  test('--repo flag forwarded when args.repo provided', async () => {
    on('gh pr diff', TWO_FILE_DIFF);
    on(
      'gh pr view',
      JSON.stringify({ url: 'https://github.com/Org/Other/pull/12' }),
    );

    await prDiffGithub({ number: 12, repo: 'Org/Other' });
    const diff = findCall('gh pr diff');
    expect(diff).toContain('--repo');
    expect(diff).toContain('Org/Other');
    const view = findCall('gh pr view');
    expect(view).toContain('--repo');
    expect(view).toContain('Org/Other');
  });
});
