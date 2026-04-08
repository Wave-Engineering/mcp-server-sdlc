import { describe, test, expect, mock, beforeEach } from 'bun:test';

// --- Mock child_process.execSync at module level ---
// We intercept execSync via a registry so individual tests can override calls.

let execRegistry: Record<string, string> = {};
let execCalls: string[] = [];
let execError: Error | null = null;

function mockExec(cmd: string): string {
  execCalls.push(cmd);
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
const { default: prListHandler } = await import('../handlers/pr_list.ts');

function parseResult(content: Array<{ type: string; text: string }>) {
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

beforeEach(() => {
  execRegistry = {};
  execCalls = [];
  execError = null;
});

describe('pr_list handler', () => {
  // --- github: head filter ---
  test('github head_filter — passes --head flag to gh pr list', async () => {
    execRegistry['git remote get-url origin'] = 'https://github.com/org/repo.git';
    execRegistry['gh pr list'] = JSON.stringify([
      {
        number: 7,
        title: 'Some PR',
        state: 'OPEN',
        headRefName: 'feature/42-thing',
        baseRefName: 'main',
        url: 'https://github.com/org/repo/pull/7',
      },
    ]);

    const result = await prListHandler.execute({ head: 'feature/42-thing' });
    const data = parseResult(result.content);

    expect(data.ok).toBe(true);
    const prs = data.prs as Array<Record<string, unknown>>;
    expect(prs).toHaveLength(1);
    expect(prs[0].number).toBe(7);
    expect(prs[0].head).toBe('feature/42-thing');
    expect(prs[0].base).toBe('main');
    expect(prs[0].url).toBe('https://github.com/org/repo/pull/7');

    const ghCall = execCalls.find((c) => c.startsWith('gh pr list')) ?? '';
    expect(ghCall).toContain("--head 'feature/42-thing'");
  });

  // --- github: state filter ---
  test('github state_filter — passes --state flag and default is open', async () => {
    execRegistry['git remote get-url origin'] = 'https://github.com/org/repo.git';
    execRegistry['gh pr list'] = JSON.stringify([]);

    // explicit state
    await prListHandler.execute({ state: 'closed' });
    let ghCall = execCalls.find((c) => c.startsWith('gh pr list')) ?? '';
    expect(ghCall).toContain("--state 'closed'");

    // default state
    execCalls = [];
    await prListHandler.execute({});
    ghCall = execCalls.find((c) => c.startsWith('gh pr list')) ?? '';
    expect(ghCall).toContain("--state 'open'");
  });

  // --- github: author filter ---
  test('github author_filter — passes --author flag when provided', async () => {
    execRegistry['git remote get-url origin'] = 'https://github.com/org/repo.git';
    execRegistry['gh pr list'] = JSON.stringify([]);

    await prListHandler.execute({ author: '@me' });
    const ghCall = execCalls.find((c) => c.startsWith('gh pr list')) ?? '';
    expect(ghCall).toContain("--author '@me'");
  });

  // --- github: author omitted ---
  test('github author_omitted — no --author flag when not provided', async () => {
    execRegistry['git remote get-url origin'] = 'https://github.com/org/repo.git';
    execRegistry['gh pr list'] = JSON.stringify([]);

    await prListHandler.execute({});
    const ghCall = execCalls.find((c) => c.startsWith('gh pr list')) ?? '';
    expect(ghCall).not.toContain('--author');
  });

  // --- github: default limit ---
  test('github default_limit — uses --limit 20 by default', async () => {
    execRegistry['git remote get-url origin'] = 'https://github.com/org/repo.git';
    execRegistry['gh pr list'] = JSON.stringify([]);

    await prListHandler.execute({});
    const ghCall = execCalls.find((c) => c.startsWith('gh pr list')) ?? '';
    expect(ghCall).toContain('--limit 20');
  });

  // --- github: custom limit ---
  test('github custom_limit — passes provided --limit', async () => {
    execRegistry['git remote get-url origin'] = 'https://github.com/org/repo.git';
    execRegistry['gh pr list'] = JSON.stringify([]);

    await prListHandler.execute({ limit: 5 });
    const ghCall = execCalls.find((c) => c.startsWith('gh pr list')) ?? '';
    expect(ghCall).toContain('--limit 5');
  });

  // --- github: base filter ---
  test('github base_filter — passes --base flag when provided', async () => {
    execRegistry['git remote get-url origin'] = 'https://github.com/org/repo.git';
    execRegistry['gh pr list'] = JSON.stringify([]);

    await prListHandler.execute({ base: 'main' });
    const ghCall = execCalls.find((c) => c.startsWith('gh pr list')) ?? '';
    expect(ghCall).toContain("--base 'main'");
  });

  // --- github: empty result ---
  test('github empty_result — returns {prs: []} not an error', async () => {
    execRegistry['git remote get-url origin'] = 'https://github.com/org/repo.git';
    execRegistry['gh pr list'] = JSON.stringify([]);

    const result = await prListHandler.execute({ head: 'feature/99-none' });
    const data = parseResult(result.content);

    expect(data.ok).toBe(true);
    expect(data.prs).toEqual([]);
  });

  // --- github: normalizes field names ---
  test('github normalize — maps headRefName/baseRefName to head/base', async () => {
    execRegistry['git remote get-url origin'] = 'https://github.com/org/repo.git';
    execRegistry['gh pr list'] = JSON.stringify([
      {
        number: 12,
        title: 'Refactor',
        state: 'OPEN',
        headRefName: 'feature/12-refactor',
        baseRefName: 'develop',
        url: 'https://github.com/org/repo/pull/12',
      },
    ]);

    const result = await prListHandler.execute({});
    const data = parseResult(result.content);
    const prs = data.prs as Array<Record<string, unknown>>;

    expect(prs[0]).toEqual({
      number: 12,
      title: 'Refactor',
      state: 'OPEN',
      head: 'feature/12-refactor',
      base: 'develop',
      url: 'https://github.com/org/repo/pull/12',
    });
  });

  // --- gitlab: head filter ---
  test('gitlab head_filter — uses --source-branch on glab mr list', async () => {
    execRegistry['git remote get-url origin'] = 'https://gitlab.com/org/repo.git';
    execRegistry['glab mr list'] = JSON.stringify([
      {
        iid: 5,
        title: 'Some MR',
        state: 'opened',
        source_branch: 'feature/5-thing',
        target_branch: 'main',
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/5',
      },
    ]);

    const result = await prListHandler.execute({ head: 'feature/5-thing' });
    const data = parseResult(result.content);

    expect(data.ok).toBe(true);
    const prs = data.prs as Array<Record<string, unknown>>;
    expect(prs).toHaveLength(1);
    expect(prs[0].number).toBe(5);
    expect(prs[0].head).toBe('feature/5-thing');
    expect(prs[0].base).toBe('main');
    expect(prs[0].url).toBe('https://gitlab.com/org/repo/-/merge_requests/5');

    const glabCall = execCalls.find((c) => c.startsWith('glab mr list')) ?? '';
    expect(glabCall).toContain("--source-branch 'feature/5-thing'");
  });

  // --- gitlab: state filter ---
  test('gitlab state_filter — passes --state flag and default is open', async () => {
    execRegistry['git remote get-url origin'] = 'https://gitlab.com/org/repo.git';
    execRegistry['glab mr list'] = JSON.stringify([]);

    await prListHandler.execute({ state: 'merged' });
    let glabCall = execCalls.find((c) => c.startsWith('glab mr list')) ?? '';
    expect(glabCall).toContain("--state 'merged'");

    execCalls = [];
    await prListHandler.execute({});
    glabCall = execCalls.find((c) => c.startsWith('glab mr list')) ?? '';
    expect(glabCall).toContain("--state 'open'");
  });

  // --- gitlab: author filter ---
  test('gitlab author_filter — passes --author flag when provided', async () => {
    execRegistry['git remote get-url origin'] = 'https://gitlab.com/org/repo.git';
    execRegistry['glab mr list'] = JSON.stringify([]);

    await prListHandler.execute({ author: 'alice' });
    const glabCall = execCalls.find((c) => c.startsWith('glab mr list')) ?? '';
    expect(glabCall).toContain("--author 'alice'");
  });

  // --- gitlab: empty result ---
  test('gitlab empty_result — returns {prs: []} not an error', async () => {
    execRegistry['git remote get-url origin'] = 'https://gitlab.com/org/repo.git';
    execRegistry['glab mr list'] = JSON.stringify([]);

    const result = await prListHandler.execute({ head: 'feature/99-none' });
    const data = parseResult(result.content);

    expect(data.ok).toBe(true);
    expect(data.prs).toEqual([]);
  });

  // --- gitlab: default limit via --per-page ---
  test('gitlab default_limit — uses --per-page 20 by default', async () => {
    execRegistry['git remote get-url origin'] = 'https://gitlab.com/org/repo.git';
    execRegistry['glab mr list'] = JSON.stringify([]);

    await prListHandler.execute({});
    const glabCall = execCalls.find((c) => c.startsWith('glab mr list')) ?? '';
    expect(glabCall).toContain('--per-page 20');
  });

  // --- gitlab: normalizes field names ---
  test('gitlab normalize — maps source_branch/target_branch to head/base and iid to number', async () => {
    execRegistry['git remote get-url origin'] = 'https://gitlab.com/org/repo.git';
    execRegistry['glab mr list'] = JSON.stringify([
      {
        iid: 21,
        title: 'Docs update',
        state: 'opened',
        source_branch: 'docs/21-update',
        target_branch: 'main',
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/21',
      },
    ]);

    const result = await prListHandler.execute({});
    const data = parseResult(result.content);
    const prs = data.prs as Array<Record<string, unknown>>;

    expect(prs[0]).toEqual({
      number: 21,
      title: 'Docs update',
      state: 'opened',
      head: 'docs/21-update',
      base: 'main',
      url: 'https://gitlab.com/org/repo/-/merge_requests/21',
    });
  });

  // --- invalid state rejected by zod ---
  test('invalid_state — returns ok:false when state is not in enum', async () => {
    const result = await prListHandler.execute({ state: 'bogus' });
    const data = parseResult(result.content);

    expect(data.ok).toBe(false);
    expect(typeof data.error).toBe('string');
  });
});
