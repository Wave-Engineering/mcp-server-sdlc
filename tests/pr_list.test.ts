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
  test('gitlab head_filter — filters by source_branch via API', async () => {
    execRegistry['git remote get-url origin'] = 'https://gitlab.com/org/repo.git';
    // Default state is 'open' -> 'opened' in GitLab API
    execRegistry['glab api projects/org%2Frepo/merge_requests?state=opened&source_branch='] = JSON.stringify([
      {
        iid: 5,
        title: 'Some MR',
        state: 'opened',
        source_branch: 'feature/5-thing',
        target_branch: 'main',
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/5',
        labels: [],
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
  });

  // --- gitlab: state filter ---
  test('gitlab state_filter — filters by state via API (merged, default opened)', async () => {
    execRegistry['git remote get-url origin'] = 'https://gitlab.com/org/repo.git';
    execRegistry['glab api projects/org%2Frepo/merge_requests?state='] = JSON.stringify([]);

    await prListHandler.execute({ state: 'merged' });
    let glabCall = execCalls.find((c) => c.includes('glab api projects/')) ?? '';
    expect(glabCall).toContain('state=merged');

    execCalls = [];
    await prListHandler.execute({});
    glabCall = execCalls.find((c) => c.includes('glab api projects/')) ?? '';
    expect(glabCall).toContain('state=opened');
  });

  // --- gitlab: author filter ---
  test('gitlab author_filter — filters by author_username via API', async () => {
    execRegistry['git remote get-url origin'] = 'https://gitlab.com/org/repo.git';
    execRegistry['glab api projects/org%2Frepo/merge_requests?author_username='] = JSON.stringify([]);

    await prListHandler.execute({ author: 'alice' });
    const glabCall = execCalls.find((c) => c.includes('glab api projects/')) ?? '';
    expect(glabCall).toContain('author_username=alice');
  });

  // --- gitlab: empty result ---
  test('gitlab empty_result — returns {prs: []} not an error', async () => {
    execRegistry['git remote get-url origin'] = 'https://gitlab.com/org/repo.git';
    execRegistry['glab api projects/org%2Frepo/merge_requests?state=opened&source_branch='] = JSON.stringify([]);

    const result = await prListHandler.execute({ head: 'feature/99-none' });
    const data = parseResult(result.content);

    expect(data.ok).toBe(true);
    expect(data.prs).toEqual([]);
  });

  // --- gitlab: default limit via per_page query param ---
  test('gitlab default_limit — uses per_page=20 by default', async () => {
    execRegistry['git remote get-url origin'] = 'https://gitlab.com/org/repo.git';
    execRegistry['glab api projects/org%2Frepo/merge_requests?state=opened&per_page=20'] = JSON.stringify([]);

    await prListHandler.execute({});
    const glabCall = execCalls.find((c) => c.includes('glab api projects/')) ?? '';
    expect(glabCall).toContain('per_page=20');
  });

  // --- gitlab: normalizes field names ---
  test('gitlab normalize — maps source_branch/target_branch to head/base and iid to number', async () => {
    execRegistry['git remote get-url origin'] = 'https://gitlab.com/org/repo.git';
    execRegistry['glab api projects/org%2Frepo/merge_requests?state=opened&per_page=20'] = JSON.stringify([
      {
        iid: 21,
        title: 'Docs update',
        state: 'opened',
        source_branch: 'docs/21-update',
        target_branch: 'main',
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/21',
        labels: [],
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

  // --- cross-repo: route_with_repo ---
  test('route_with_repo — forwards --repo to gh pr list when repo arg provided (github)', async () => {
    // cwd origin is a DIFFERENT repo — repo arg must override.
    execRegistry['git remote get-url origin'] = 'https://github.com/Wave-Engineering/claudecode-workflow.git';
    execRegistry['gh pr list'] = JSON.stringify([]);

    await prListHandler.execute({ repo: 'Wave-Engineering/mcp-server-sdlc' });
    const ghCall = execCalls.find((c) => c.startsWith('gh pr list')) ?? '';
    expect(ghCall).toContain("--repo 'Wave-Engineering/mcp-server-sdlc'");
  });

  test('route_with_repo — forwards owner/repo into glab api URL path (gitlab)', async () => {
    execRegistry['git remote get-url origin'] = 'https://gitlab.com/other-org/other-repo.git';
    execRegistry['glab api projects/target-org%2Ftarget-repo/merge_requests'] = JSON.stringify([]);

    await prListHandler.execute({ repo: 'target-org/target-repo' });
    const glabCall = execCalls.find((c) => c.includes('glab api projects/')) ?? '';
    expect(glabCall).toContain('target-org%2Ftarget-repo');
    // Must NOT use the cwd-derived slug.
    expect(glabCall).not.toContain('other-org%2Fother-repo');
  });

  // --- cross-repo: regression_without_repo ---
  test('regression_without_repo — no repo arg preserves cwd-based behavior (github)', async () => {
    execRegistry['git remote get-url origin'] = 'https://github.com/org/repo.git';
    execRegistry['gh pr list'] = JSON.stringify([]);

    await prListHandler.execute({});
    const ghCall = execCalls.find((c) => c.startsWith('gh pr list')) ?? '';
    expect(ghCall).not.toContain('--repo');
  });

  test('regression_without_repo — glab api uses cwd slug when no repo arg (gitlab)', async () => {
    execRegistry['git remote get-url origin'] = 'https://gitlab.com/cwd-org/cwd-repo.git';
    execRegistry['glab api projects/cwd-org%2Fcwd-repo/merge_requests'] = JSON.stringify([]);

    await prListHandler.execute({});
    const glabCall = execCalls.find((c) => c.includes('glab api projects/')) ?? '';
    expect(glabCall).toContain('cwd-org%2Fcwd-repo');
  });

  // --- cross-repo: invalid_slug_early_error ---
  test('invalid_slug_early_error — malformed repo returns ok:false with zero exec calls', async () => {
    // No registry entries — any exec attempt would throw "Unexpected".
    const result = await prListHandler.execute({ repo: 'not-a-slug' });
    const data = parseResult(result.content);

    expect(data.ok).toBe(false);
    expect(typeof data.error).toBe('string');
    // Crucially: no subprocess call was made.
    expect(execCalls).toHaveLength(0);
  });
});
