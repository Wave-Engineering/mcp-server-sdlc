import { describe, test, expect, mock, beforeEach } from 'bun:test';

// --- Mock child_process.execSync at module level ---
let execRegistry: Record<string, string> = {};
let execError: Error | null = null;

function mockExec(cmd: string): string {
  if (execError) throw execError;
  for (const [key, value] of Object.entries(execRegistry)) {
    if (cmd.includes(key)) return value;
  }
  throw new Error(`Unexpected exec call: ${cmd}`);
}

mock.module('child_process', () => ({
  execSync: (cmd: string, _opts?: unknown) => mockExec(cmd),
}));

// Import AFTER the mock is registered
const { default: prFilesHandler, parseDiffStats } = await import('../handlers/pr_files.ts');

function parseResult(content: Array<{ type: string; text: string }>) {
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

beforeEach(() => {
  execRegistry = {};
  execError = null;
});

describe('pr_files handler — shape', () => {
  test('exports valid HandlerDef', () => {
    expect(prFilesHandler.name).toBe('pr_files');
    expect(typeof prFilesHandler.execute).toBe('function');
  });

  test('schema_validation — rejects missing number', async () => {
    const result = await prFilesHandler.execute({});
    const data = parseResult(result.content);
    expect(data.ok).toBe(false);
  });

  test('schema_validation — rejects non-positive number', async () => {
    const result = await prFilesHandler.execute({ number: 0 });
    const data = parseResult(result.content);
    expect(data.ok).toBe(false);
  });

  test('schema_validation — rejects non-integer number', async () => {
    const result = await prFilesHandler.execute({ number: 3.5 });
    const data = parseResult(result.content);
    expect(data.ok).toBe(false);
  });
});

describe('parseDiffStats helper', () => {
  test('empty diff returns zeros', () => {
    expect(parseDiffStats('')).toEqual({ additions: 0, deletions: 0 });
  });

  test('counts additions and deletions ignoring headers', () => {
    const diff = [
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -1,3 +1,4 @@',
      ' context',
      '-removed line',
      '+added line 1',
      '+added line 2',
      ' more context',
    ].join('\n');
    const stats = parseDiffStats(diff);
    expect(stats.additions).toBe(2);
    expect(stats.deletions).toBe(1);
  });

  test('ignores multiple header blocks in a single diff', () => {
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
    const stats = parseDiffStats(diff);
    expect(stats.additions).toBe(2);
    expect(stats.deletions).toBe(1);
  });

  test('pure-add diff counts only additions', () => {
    const diff = ['--- /dev/null', '+++ b/new.ts', '@@ -0,0 +1,3 @@', '+line a', '+line b', '+line c'].join(
      '\n',
    );
    const stats = parseDiffStats(diff);
    expect(stats.additions).toBe(3);
    expect(stats.deletions).toBe(0);
  });
});

describe('pr_files handler — GitHub', () => {
  test('added_only_pr — single added file maps correctly', async () => {
    execRegistry['git remote get-url origin'] = 'https://github.com/org/repo.git';
    execRegistry['gh pr view 10'] = JSON.stringify({
      files: [{ path: 'src/new.ts', additions: 12, deletions: 0, changeType: 'ADDED' }],
    });

    const result = await prFilesHandler.execute({ number: 10 });
    const data = parseResult(result.content);

    expect(data.ok).toBe(true);
    expect(data.number).toBe(10);
    const files = data.files as Array<Record<string, unknown>>;
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('src/new.ts');
    expect(files[0].status).toBe('added');
    expect(files[0].additions).toBe(12);
    expect(files[0].deletions).toBe(0);
    expect(data.total_additions).toBe(12);
    expect(data.total_deletions).toBe(0);
  });

  test('mixed_changes_pr — mixture of added/modified/removed/renamed', async () => {
    execRegistry['git remote get-url origin'] = 'https://github.com/org/repo.git';
    execRegistry['gh pr view 42'] = JSON.stringify({
      files: [
        { path: 'a.ts', additions: 5, deletions: 0, changeType: 'ADDED' },
        { path: 'b.ts', additions: 3, deletions: 2, changeType: 'MODIFIED' },
        { path: 'c.ts', additions: 0, deletions: 7, changeType: 'REMOVED' },
        { path: 'd2.ts', additions: 1, deletions: 1, changeType: 'RENAMED' },
      ],
    });

    const result = await prFilesHandler.execute({ number: 42 });
    const data = parseResult(result.content);

    expect(data.ok).toBe(true);
    const files = data.files as Array<Record<string, unknown>>;
    expect(files).toHaveLength(4);
    expect(files.map(f => f.status)).toEqual(['added', 'modified', 'removed', 'renamed']);
    expect(data.total_additions).toBe(9);
    expect(data.total_deletions).toBe(10);
  });

  test('rename_only_pr — renamed file reports stats from GitHub', async () => {
    execRegistry['git remote get-url origin'] = 'https://github.com/org/repo.git';
    execRegistry['gh pr view 7'] = JSON.stringify({
      files: [{ path: 'renamed.ts', additions: 0, deletions: 0, changeType: 'RENAMED' }],
    });

    const result = await prFilesHandler.execute({ number: 7 });
    const data = parseResult(result.content);

    expect(data.ok).toBe(true);
    const files = data.files as Array<Record<string, unknown>>;
    expect(files[0].status).toBe('renamed');
    expect(files[0].additions).toBe(0);
    expect(files[0].deletions).toBe(0);
  });

  test('empty_files_list — no files returns empty array and zero totals', async () => {
    execRegistry['git remote get-url origin'] = 'https://github.com/org/repo.git';
    execRegistry['gh pr view 99'] = JSON.stringify({ files: [] });

    const result = await prFilesHandler.execute({ number: 99 });
    const data = parseResult(result.content);

    expect(data.ok).toBe(true);
    expect(data.files).toEqual([]);
    expect(data.total_additions).toBe(0);
    expect(data.total_deletions).toBe(0);
  });

  test('gh_error — exec failure returns structured error', async () => {
    execRegistry['git remote get-url origin'] = 'https://github.com/org/repo.git';
    execError = new Error('gh: not found');

    const result = await prFilesHandler.execute({ number: 1 });
    const data = parseResult(result.content);

    expect(data.ok).toBe(false);
    expect(data.error).toContain('gh');
  });
});

describe('pr_files handler — GitLab', () => {
  test('added_only_mr — new file computes additions from diff hunks', async () => {
    execRegistry['git remote get-url origin'] = 'https://gitlab.com/org/repo.git';
    execRegistry['glab mr view 3'] = JSON.stringify({
      changes: [
        {
          new_path: 'src/brand-new.ts',
          old_path: 'src/brand-new.ts',
          new_file: true,
          renamed_file: false,
          deleted_file: false,
          diff: '--- /dev/null\n+++ b/src/brand-new.ts\n@@ -0,0 +1,3 @@\n+line one\n+line two\n+line three\n',
        },
      ],
    });

    const result = await prFilesHandler.execute({ number: 3 });
    const data = parseResult(result.content);

    expect(data.ok).toBe(true);
    expect(data.number).toBe(3);
    const files = data.files as Array<Record<string, unknown>>;
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('src/brand-new.ts');
    expect(files[0].status).toBe('added');
    expect(files[0].additions).toBe(3);
    expect(files[0].deletions).toBe(0);
    expect(data.total_additions).toBe(3);
    expect(data.total_deletions).toBe(0);
  });

  test('mixed_changes_mr — added/modified/removed/renamed with computed stats', async () => {
    execRegistry['git remote get-url origin'] = 'https://gitlab.com/org/repo.git';
    execRegistry['glab mr view 11'] = JSON.stringify({
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
    });

    const result = await prFilesHandler.execute({ number: 11 });
    const data = parseResult(result.content);

    expect(data.ok).toBe(true);
    const files = data.files as Array<Record<string, unknown>>;
    expect(files).toHaveLength(4);

    expect(files[0]).toMatchObject({
      path: 'added.ts',
      status: 'added',
      additions: 2,
      deletions: 0,
    });
    expect(files[1]).toMatchObject({
      path: 'modified.ts',
      status: 'modified',
      additions: 1,
      deletions: 1,
    });
    expect(files[2]).toMatchObject({
      path: 'removed.ts',
      status: 'removed',
      additions: 0,
      deletions: 3,
    });
    expect(files[3]).toMatchObject({
      path: 'new-name.ts',
      status: 'renamed',
      additions: 0,
      deletions: 0,
    });

    expect(data.total_additions).toBe(3);
    expect(data.total_deletions).toBe(4);
  });

  test('rename_with_modifications_mr — renamed file with diff still counts stats', async () => {
    execRegistry['git remote get-url origin'] = 'https://gitlab.com/org/repo.git';
    execRegistry['glab mr view 15'] = JSON.stringify({
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
    });

    const result = await prFilesHandler.execute({ number: 15 });
    const data = parseResult(result.content);

    expect(data.ok).toBe(true);
    const files = data.files as Array<Record<string, unknown>>;
    expect(files[0].status).toBe('renamed');
    expect(files[0].path).toBe('b.ts');
    expect(files[0].additions).toBe(2);
    expect(files[0].deletions).toBe(1);
  });

  test('empty_changes_mr — missing changes field returns empty list', async () => {
    execRegistry['git remote get-url origin'] = 'https://gitlab.com/org/repo.git';
    execRegistry['glab mr view 50'] = JSON.stringify({});

    const result = await prFilesHandler.execute({ number: 50 });
    const data = parseResult(result.content);

    expect(data.ok).toBe(true);
    expect(data.files).toEqual([]);
    expect(data.total_additions).toBe(0);
    expect(data.total_deletions).toBe(0);
  });
});
