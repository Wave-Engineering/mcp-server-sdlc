import { describe, test, expect, mock, beforeEach } from 'bun:test';

// --- Mock child_process.execSync at module level ---
// We intercept execSync via a registry so individual tests can override calls.

let execRegistry: Array<{ match: string; value: string }> = [];
let execError: Error | null = null;
let execCalls: string[] = [];

function mockExec(cmd: string): string {
  execCalls.push(cmd);
  if (execError) throw execError;
  for (const { match, value } of execRegistry) {
    if (cmd.includes(match)) return value;
  }
  throw new Error(`Unexpected exec call: ${cmd}`);
}

mock.module('child_process', () => ({
  execSync: (cmd: string, _opts?: unknown) => mockExec(cmd),
}));

// Import AFTER the mock is registered
const { default: prDiffHandler } = await import('../handlers/pr_diff.ts');

function parseResult(content: Array<{ type: string; text: string }>) {
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

function register(match: string, value: string) {
  execRegistry.push({ match, value });
}

beforeEach(() => {
  execRegistry = [];
  execError = null;
  execCalls = [];
});

const SMALL_DIFF = `diff --git a/foo.txt b/foo.txt
index 1234567..89abcde 100644
--- a/foo.txt
+++ b/foo.txt
@@ -1,3 +1,3 @@
 line one
-old line
+new line
 line three
`;

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

describe('pr_diff handler', () => {
  // --- input validation ---
  test('invalid_input — missing number returns error', async () => {
    const result = await prDiffHandler.execute({});
    const data = parseResult(result.content);
    expect(data.ok).toBe(false);
    expect(typeof data.error).toBe('string');
  });

  test('invalid_input — non-positive number returns error', async () => {
    const result = await prDiffHandler.execute({ number: 0 });
    const data = parseResult(result.content);
    expect(data.ok).toBe(false);
  });

  // --- normal diff, github ---
  test('normal_github — returns full diff with counts', async () => {
    register('git remote get-url origin', 'https://github.com/org/repo.git');
    register('gh pr diff 42', TWO_FILE_DIFF);
    register(
      'gh pr view 42',
      JSON.stringify({ url: 'https://github.com/org/repo/pull/42' })
    );

    const result = await prDiffHandler.execute({ number: 42 });
    const data = parseResult(result.content);

    expect(data.ok).toBe(true);
    expect(data.number).toBe(42);
    expect(data.diff).toBe(TWO_FILE_DIFF);
    expect(data.file_count).toBe(2);
    expect(data.line_count).toBe(14);
    expect(data.url).toBe('https://github.com/org/repo/pull/42');
    expect(data.truncated).toBe(false);
  });

  // --- small single-file diff, github ---
  test('small_github — single file counts correctly', async () => {
    register('git remote get-url origin', 'https://github.com/org/repo.git');
    register('gh pr diff 7', SMALL_DIFF);
    register(
      'gh pr view 7',
      JSON.stringify({ url: 'https://github.com/org/repo/pull/7' })
    );

    const result = await prDiffHandler.execute({ number: 7 });
    const data = parseResult(result.content);

    expect(data.ok).toBe(true);
    expect(data.file_count).toBe(1);
    expect(data.line_count).toBe(9);
    expect(data.truncated).toBe(false);
  });

  // --- empty diff (no-op PR) ---
  test('empty_diff — returns zero counts', async () => {
    register('git remote get-url origin', 'https://github.com/org/repo.git');
    register('gh pr diff 99', '');
    register(
      'gh pr view 99',
      JSON.stringify({ url: 'https://github.com/org/repo/pull/99' })
    );

    const result = await prDiffHandler.execute({ number: 99 });
    const data = parseResult(result.content);

    expect(data.ok).toBe(true);
    expect(data.diff).toBe('');
    expect(data.line_count).toBe(0);
    expect(data.file_count).toBe(0);
    expect(data.truncated).toBe(false);
  });

  // --- huge diff triggers truncation ---
  test('huge_diff — triggers safety-valve truncation above 10000 lines', async () => {
    const huge = buildHugeDiff(20000);
    register('git remote get-url origin', 'https://github.com/org/repo.git');
    register('gh pr diff 500', huge);
    register(
      'gh pr view 500',
      JSON.stringify({ url: 'https://github.com/org/repo/pull/500' })
    );

    const result = await prDiffHandler.execute({ number: 500 });
    const data = parseResult(result.content);

    expect(data.ok).toBe(true);
    expect(data.truncated).toBe(true);

    const diff = data.diff as string;
    // Must contain the omission marker
    expect(diff).toContain('lines omitted');
    // Must preserve the head
    expect(diff.startsWith('diff --git a/big.txt b/big.txt')).toBe(true);
    // Truncated diff must be dramatically smaller than the original
    expect(diff.split('\n').length).toBeLessThan(huge.split('\n').length);
    // Should keep roughly 10000 content lines + 1 marker line
    const truncatedLineCount = data.line_count as number;
    expect(truncatedLineCount).toBeGreaterThan(10000);
    expect(truncatedLineCount).toBeLessThan(10010);
  });

  // --- right at threshold, no truncation ---
  test('at_threshold — exactly 10000 lines is NOT truncated', async () => {
    const atLimit = buildHugeDiff(10000);
    register('git remote get-url origin', 'https://github.com/org/repo.git');
    register('gh pr diff 123', atLimit);
    register(
      'gh pr view 123',
      JSON.stringify({ url: 'https://github.com/org/repo/pull/123' })
    );

    const result = await prDiffHandler.execute({ number: 123 });
    const data = parseResult(result.content);

    expect(data.ok).toBe(true);
    expect(data.truncated).toBe(false);
    expect(data.diff).toBe(atLimit);
  });

  // --- gitlab platform ---
  test('gitlab_platform — uses glab commands when origin is gitlab', async () => {
    register('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    register('glab mr diff 11', TWO_FILE_DIFF);
    register(
      'glab api projects/org%2Frepo/merge_requests/11',
      JSON.stringify({ web_url: 'https://gitlab.com/org/repo/-/merge_requests/11' })
    );

    const result = await prDiffHandler.execute({ number: 11 });
    const data = parseResult(result.content);

    expect(data.ok).toBe(true);
    expect(data.number).toBe(11);
    expect(data.diff).toBe(TWO_FILE_DIFF);
    expect(data.file_count).toBe(2);
    expect(data.url).toBe('https://gitlab.com/org/repo/-/merge_requests/11');
    expect(data.truncated).toBe(false);
  });

  // --- gitlab empty diff ---
  test('gitlab_empty — empty MR diff on gitlab returns zero counts', async () => {
    register('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    register('glab mr diff 22', '');
    register(
      'glab api projects/org%2Frepo/merge_requests/22',
      JSON.stringify({ web_url: 'https://gitlab.com/org/repo/-/merge_requests/22' })
    );

    const result = await prDiffHandler.execute({ number: 22 });
    const data = parseResult(result.content);

    expect(data.ok).toBe(true);
    expect(data.line_count).toBe(0);
    expect(data.file_count).toBe(0);
  });

  // --- cli failure is surfaced as ok:false ---
  test('cli_failure — underlying command error is surfaced', async () => {
    execError = new Error('gh: authentication required');
    const result = await prDiffHandler.execute({ number: 1 });
    const data = parseResult(result.content);
    expect(data.ok).toBe(false);
    expect((data.error as string)).toContain('authentication');
  });

  // --- cross-repo routing ---

  test('route_with_repo — github threads --repo into gh pr diff and gh pr view', async () => {
    register('git remote get-url origin', 'https://github.com/cwd-org/cwd-repo.git');
    register('gh pr diff 42', SMALL_DIFF);
    register(
      'gh pr view 42 --json url',
      JSON.stringify({ url: 'https://github.com/Wave-Engineering/mcp-server-sdlc/pull/42' }),
    );

    const result = await prDiffHandler.execute({
      number: 42,
      repo: 'Wave-Engineering/mcp-server-sdlc',
    });
    const data = parseResult(result.content);
    expect(data.ok).toBe(true);

    const diffCall = execCalls.find((c) => c.startsWith('gh pr diff 42')) ?? '';
    expect(diffCall).toContain('--repo Wave-Engineering/mcp-server-sdlc');
    const viewCall = execCalls.find((c) => c.startsWith('gh pr view 42')) ?? '';
    expect(viewCall).toContain('--repo Wave-Engineering/mcp-server-sdlc');
  });

  test('route_with_repo — gitlab forwards slug into glab mr diff + glab api path', async () => {
    register('git remote get-url origin', 'https://gitlab.com/cwd-org/cwd-repo.git');
    register('glab mr diff 11', SMALL_DIFF);
    register(
      'glab api projects/target-org%2Ftarget-repo/merge_requests/11',
      JSON.stringify({ web_url: 'https://gitlab.com/target-org/target-repo/-/merge_requests/11' }),
    );

    const result = await prDiffHandler.execute({
      number: 11,
      repo: 'target-org/target-repo',
    });
    const data = parseResult(result.content);
    expect(data.ok).toBe(true);

    const diffCall = execCalls.find((c) => c.startsWith('glab mr diff 11')) ?? '';
    expect(diffCall).toContain('--repo target-org/target-repo');
    const apiCall = execCalls.find((c) => c.includes('glab api projects/')) ?? '';
    expect(apiCall).toContain('target-org%2Ftarget-repo');
    expect(apiCall).not.toContain('cwd-org%2Fcwd-repo');
  });

  test('regression_without_repo — gh pr diff call does not contain --repo', async () => {
    register('git remote get-url origin', 'https://github.com/org/repo.git');
    register('gh pr diff 7', SMALL_DIFF);
    register(
      'gh pr view 7 --json url',
      JSON.stringify({ url: 'https://github.com/org/repo/pull/7' }),
    );

    await prDiffHandler.execute({ number: 7 });

    const diffCall = execCalls.find((c) => c.startsWith('gh pr diff 7')) ?? '';
    expect(diffCall).not.toContain('--repo');
    const viewCall = execCalls.find((c) => c.startsWith('gh pr view 7')) ?? '';
    expect(viewCall).not.toContain('--repo');
  });

  test('invalid_slug_early_error — returns ok:false with zero exec calls', async () => {
    const result = await prDiffHandler.execute({ number: 1, repo: 'no-slash' });
    const data = parseResult(result.content);

    expect(data.ok).toBe(false);
    expect(typeof data.error).toBe('string');
    expect(execCalls).toHaveLength(0);
  });
});
