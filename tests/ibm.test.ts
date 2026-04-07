import { describe, test, expect, mock, beforeEach } from 'bun:test';

// --- Mock child_process.execSync at module level ---
// We intercept execSync via a registry so individual tests can override calls.

let execRegistry: Record<string, string> = {};
let execError: Error | null = null;

function mockExec(cmd: string): string {
  if (execError) throw execError;
  // Match by prefix/substring
  for (const [key, value] of Object.entries(execRegistry)) {
    if (cmd.includes(key)) return value;
  }
  throw new Error(`Unexpected exec call: ${cmd}`);
}

mock.module('child_process', () => ({
  execSync: (cmd: string, _opts?: unknown) => mockExec(cmd),
}));

// Import AFTER the mock is registered
const { default: ibmHandler } = await import('../handlers/ibm.ts');

function parseResult(content: Array<{ type: string; text: string }>) {
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

beforeEach(() => {
  execRegistry = {};
  execError = null;
});

describe('ibm handler', () => {
  // --- protected_branch_main ---
  test('protected_branch_main — returns error for main branch', async () => {
    execRegistry['git branch --show-current'] = 'main';

    const result = await ibmHandler.execute({});
    const data = parseResult(result.content);

    expect(data.ok).toBe(false);
    expect((data.error as string)).toContain("protected");
  });

  // --- protected_branch_release ---
  test('protected_branch_release — returns error for release/* branch', async () => {
    execRegistry['git branch --show-current'] = 'release/1.0';

    const result = await ibmHandler.execute({});
    const data = parseResult(result.content);

    expect(data.ok).toBe(false);
    expect((data.error as string)).toContain("protected");
  });

  // --- no_issue_in_branch ---
  test('no_issue_in_branch — branch without issue number returns error', async () => {
    execRegistry['git branch --show-current'] = 'feat-no-number';

    const result = await ibmHandler.execute({});
    const data = parseResult(result.content);

    expect(data.ok).toBe(false);
    expect(data.error).toBe('Branch has no linked issue. Name format: type/NNN-description');
  });

  // --- issue_open ---
  test('issue_open — open issue returns success response', async () => {
    const branch = 'feature/42-my-thing';
    execRegistry['git branch --show-current'] = branch;
    execRegistry['git remote get-url origin'] = 'https://github.com/org/repo.git';
    execRegistry['gh issue view 42'] = JSON.stringify({
      state: 'OPEN',
      title: 'My Thing',
      url: 'https://github.com/org/repo/issues/42',
    });
    execRegistry['gh pr list --head'] = JSON.stringify([]);

    const result = await ibmHandler.execute({});
    const data = parseResult(result.content);

    expect(data.ok).toBe(true);
    expect(data.issue_number).toBe(42);
    expect(data.issue_title).toBe('My Thing');
    expect(data.issue_url).toBe('https://github.com/org/repo/issues/42');
    expect(data.branch).toBe(branch);
    expect(data.pr_url).toBeNull();
    expect((data.message as string)).toContain('issue #42 is open');
  });

  // --- issue_open with explicit branch arg ---
  test('issue_open — uses provided branch arg instead of git command', async () => {
    const branch = 'fix/99-some-fix';
    execRegistry['git remote get-url origin'] = 'https://github.com/org/repo.git';
    execRegistry['gh issue view 99'] = JSON.stringify({
      state: 'OPEN',
      title: 'Some Fix',
      url: 'https://github.com/org/repo/issues/99',
    });
    execRegistry['gh pr list --head'] = JSON.stringify([]);

    const result = await ibmHandler.execute({ branch });
    const data = parseResult(result.content);

    expect(data.ok).toBe(true);
    expect(data.issue_number).toBe(99);
  });

  // --- issue_closed ---
  test('issue_closed — closed issue returns warning response', async () => {
    const branch = 'feature/42-my-thing';
    execRegistry['git branch --show-current'] = branch;
    execRegistry['git remote get-url origin'] = 'https://github.com/org/repo.git';
    execRegistry['gh issue view 42'] = JSON.stringify({
      state: 'CLOSED',
      title: 'My Thing',
      url: 'https://github.com/org/repo/issues/42',
    });

    const result = await ibmHandler.execute({});
    const data = parseResult(result.content);

    expect(data.ok).toBe(true);
    expect((data.warning as string)).toContain('closed');
    expect(data.issue_number).toBe(42);
    expect(data.branch).toBe(branch);
  });

  // --- pr_present ---
  test('pr_present — PR on branch is included in response', async () => {
    const branch = 'feature/42-my-thing';
    execRegistry['git branch --show-current'] = branch;
    execRegistry['git remote get-url origin'] = 'https://github.com/org/repo.git';
    execRegistry['gh issue view 42'] = JSON.stringify({
      state: 'OPEN',
      title: 'My Thing',
      url: 'https://github.com/org/repo/issues/42',
    });
    execRegistry['gh pr list --head'] = JSON.stringify([
      { number: 7, url: 'https://github.com/org/repo/pull/7' },
    ]);

    const result = await ibmHandler.execute({});
    const data = parseResult(result.content);

    expect(data.ok).toBe(true);
    expect(data.pr_url).toBe('https://github.com/org/repo/pull/7');
  });

  // --- all 4 type prefixes ---
  test('branch_types — feature, fix, chore, docs prefixes all parse correctly', async () => {
    const types = ['feature', 'fix', 'chore', 'docs'];

    for (const type of types) {
      const branch = `${type}/10-something`;
      execRegistry['git branch --show-current'] = branch;
      execRegistry['git remote get-url origin'] = 'https://github.com/org/repo.git';
      execRegistry['gh issue view 10'] = JSON.stringify({
        state: 'OPEN',
        title: 'Something',
        url: 'https://github.com/org/repo/issues/10',
      });
      execRegistry['gh pr list --head'] = JSON.stringify([]);

      const result = await ibmHandler.execute({});
      const data = parseResult(result.content);

      expect(data.ok).toBe(true);
      expect(data.issue_number).toBe(10);
    }
  });

  // --- gitlab platform ---
  test('gitlab_platform — uses glab commands when origin is gitlab', async () => {
    const branch = 'feature/5-gitlab-test';
    execRegistry['git branch --show-current'] = branch;
    execRegistry['git remote get-url origin'] = 'https://gitlab.com/org/repo.git';
    execRegistry['glab issue view 5'] = JSON.stringify({
      state: 'opened',
      title: 'GitLab Test',
      web_url: 'https://gitlab.com/org/repo/-/issues/5',
    });
    execRegistry['glab mr list'] = JSON.stringify([]);

    const result = await ibmHandler.execute({});
    const data = parseResult(result.content);

    expect(data.ok).toBe(true);
    expect(data.issue_number).toBe(5);
    expect(data.issue_url).toBe('https://gitlab.com/org/repo/-/issues/5');
  });
});
