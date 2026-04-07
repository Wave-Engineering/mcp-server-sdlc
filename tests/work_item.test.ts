import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';

// ---- Mocks ----------------------------------------------------------------
// We intercept child_process.execSync and fs.writeFileSync so no OS calls happen.

let lastExecCall = '';
let execMockFn: (cmd: string) => string = () => 'https://github.com/org/repo/issues/42\n';

const mockExecSync = mock((cmd: string, _opts?: unknown) => {
  lastExecCall = cmd;
  return execMockFn(cmd);
});

const mockWriteFileSync = mock((_path: unknown, _data: unknown) => undefined);

// Patch modules before importing the handler
mock.module('child_process', () => ({ execSync: mockExecSync }));
mock.module('fs', () => ({ writeFileSync: mockWriteFileSync }));

// Now import handler (after mocks are in place)
const { default: handler } = await import('../handlers/work_item.ts');

// ---- Helpers ----------------------------------------------------------------
function resetMocks() {
  lastExecCall = '';
  mockExecSync.mockClear();
  mockWriteFileSync.mockClear();
}

function setOriginUrl(url: string) {
  execMockFn = (cmd: string) => {
    if (cmd.startsWith('git remote get-url')) return url + '\n';
    return 'https://github.com/org/repo/issues/42\n';
  };
}

function setGitlabOrigin() {
  execMockFn = (cmd: string) => {
    if (cmd.startsWith('git remote get-url')) return 'git@gitlab.com:org/repo.git\n';
    return 'https://gitlab.com/org/repo/-/issues/7\n';
  };
}

// ---- Tests -----------------------------------------------------------------

describe('work_item handler', () => {
  beforeEach(resetMocks);
  afterEach(resetMocks);

  // ---- routes_issue_to_gh_issue_create ------------------------------------
  test('routes_issue_to_gh_issue_create — GitHub issue types use gh issue create', async () => {
    setOriginUrl('https://github.com/org/repo.git');
    const result = await handler.execute({ type: 'story', title: 'My story', body: 'details' });
    const calls = mockExecSync.mock.calls.map(c => c[0] as string);
    const createCall = calls.find(c => c.includes('gh issue create'));
    expect(createCall).toBeDefined();
    expect(createCall).toContain('gh issue create');
    expect(createCall).toContain('My story');
    const parsed = JSON.parse((result.content[0] as { type: string; text: string }).text);
    expect(parsed.ok).toBe(true);
  });

  test('routes_issue_to_gh_issue_create — bug type also uses gh issue create', async () => {
    setOriginUrl('https://github.com/org/repo.git');
    await handler.execute({ type: 'bug', title: 'A bug' });
    const calls = mockExecSync.mock.calls.map(c => c[0] as string);
    expect(calls.some(c => c.includes('gh issue create'))).toBe(true);
  });

  // ---- routes_pr_to_gh_pr_create ------------------------------------------
  test('routes_pr_to_gh_pr_create — GitHub PR uses gh pr create', async () => {
    setOriginUrl('https://github.com/org/repo.git');
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote get-url')) return 'https://github.com/org/repo.git\n';
      return 'https://github.com/org/repo/pull/99\n';
    };
    const result = await handler.execute({
      type: 'pr',
      title: 'My PR',
      head_branch: 'feature/1-foo',
      base_branch: 'main',
      draft: true,
    });
    const calls = mockExecSync.mock.calls.map(c => c[0] as string);
    const prCall = calls.find(c => c.includes('gh pr create'));
    expect(prCall).toBeDefined();
    expect(prCall).toContain('--head feature/1-foo');
    expect(prCall).toContain('--base main');
    expect(prCall).toContain('--draft');
    const parsed = JSON.parse((result.content[0] as { type: string; text: string }).text);
    expect(parsed.ok).toBe(true);
    expect(parsed.number).toBe(99);
  });

  // ---- routes_mr_to_glab_mr_create ----------------------------------------
  test('routes_mr_to_glab_mr_create — GitLab MR uses glab mr create', async () => {
    setGitlabOrigin();
    const result = await handler.execute({
      type: 'mr',
      title: 'My MR',
      head_branch: 'feature/2-bar',
      base_branch: 'main',
    });
    const calls = mockExecSync.mock.calls.map(c => c[0] as string);
    const mrCall = calls.find(c => c.includes('glab mr create'));
    expect(mrCall).toBeDefined();
    expect(mrCall).toContain('--source-branch feature/2-bar');
    expect(mrCall).toContain('--target-branch main');
    const parsed = JSON.parse((result.content[0] as { type: string; text: string }).text);
    expect(parsed.ok).toBe(true);
  });

  // ---- merges_type_label --------------------------------------------------
  test('merges_type_label — automatic type::* label merged with caller labels', async () => {
    setOriginUrl('https://github.com/org/repo.git');
    await handler.execute({ type: 'epic', title: 'Big epic', labels: ['priority::high'] });
    const calls = mockExecSync.mock.calls.map(c => c[0] as string);
    const createCall = calls.find(c => c.includes('gh issue create'));
    expect(createCall).toBeDefined();
    expect(createCall).toContain('type::epic');
    expect(createCall).toContain('priority::high');
  });

  test('merges_type_label — pr type gets no automatic type label', async () => {
    setOriginUrl('https://github.com/org/repo.git');
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote get-url')) return 'https://github.com/org/repo.git\n';
      return 'https://github.com/org/repo/pull/5\n';
    };
    await handler.execute({ type: 'pr', title: 'Patch', labels: ['size::S'] });
    const calls = mockExecSync.mock.calls.map(c => c[0] as string);
    const prCall = calls.find(c => c.includes('gh pr create'));
    expect(prCall).toBeDefined();
    expect(prCall).not.toContain('type::pr');
    expect(prCall).toContain('size::S');
  });

  // ---- pr_fields_ignored_for_issue ----------------------------------------
  test('pr_fields_ignored_for_issue — head_branch not passed to issue create', async () => {
    setOriginUrl('https://github.com/org/repo.git');
    await handler.execute({ type: 'chore', title: 'Cleanup', head_branch: 'feature/9-foo' });
    const calls = mockExecSync.mock.calls.map(c => c[0] as string);
    const createCall = calls.find(c => c.includes('gh issue create'));
    expect(createCall).toBeDefined();
    expect(createCall).not.toContain('--head');
    expect(createCall).not.toContain('feature/9-foo');
  });

  // ---- routes_gitlab_issue ------------------------------------------------
  test('routes_gitlab_issue — GitLab issue types use glab issue create', async () => {
    setGitlabOrigin();
    const result = await handler.execute({ type: 'story', title: 'GL story', labels: ['team::alpha'] });
    const calls = mockExecSync.mock.calls.map(c => c[0] as string);
    const createCall = calls.find(c => c.includes('glab issue create'));
    expect(createCall).toBeDefined();
    expect(createCall).toContain('GL story');
    expect(createCall).toContain('type::story');
    const parsed = JSON.parse((result.content[0] as { type: string; text: string }).text);
    expect(parsed.ok).toBe(true);
  });

  // ---- error handling -----------------------------------------------------
  test('returns ok:false on exec failure', async () => {
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote get-url')) return 'https://github.com/org/repo.git\n';
      throw new Error('gh: command not found');
    };
    const result = await handler.execute({ type: 'bug', title: 'Boom' });
    const parsed = JSON.parse((result.content[0] as { type: string; text: string }).text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('gh: command not found');
  });

  // ---- body written to temp file ------------------------------------------
  test('writes body to temp file before exec', async () => {
    setOriginUrl('https://github.com/org/repo.git');
    await handler.execute({ type: 'docs', title: 'Update readme', body: 'Some body text' });
    expect(mockWriteFileSync.mock.calls.length).toBeGreaterThan(0);
    const writtenPath = mockWriteFileSync.mock.calls[0][0] as string;
    const writtenBody = mockWriteFileSync.mock.calls[0][1] as string;
    expect(writtenPath).toMatch(/^\/tmp\/wi-body-\d+\.md$/);
    expect(writtenBody).toBe('Some body text');
  });
});
