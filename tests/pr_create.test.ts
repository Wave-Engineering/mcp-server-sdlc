import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';

// pr_create now uses child_process.execSync (story #238 — normalize subprocess
// invocation). Tests intercept the boundary via `mock.module('child_process', ...)`
// — same pattern as pr_merge.test.ts. Each test populates `execRegistry` with
// substring → responder mappings; an unmatched call throws so missing stubs
// surface loudly.

interface ThrowableError extends Error {
  stderr?: string;
  stdout?: string;
  status?: number;
}

type Responder = string | (() => string);

let execRegistry: Array<{ match: string; respond: Responder }> = [];
let execCalls: string[] = [];

// Strip the shell-quoting layer the handler applies so test match-keys can be
// authored as plain `gh pr create` rather than `'gh' 'pr' 'create'`. We only
// remove single-quotes that surround whole tokens — argument values that
// happen to contain quoted substrings still match correctly.
function unquote(cmd: string): string {
  return cmd.replace(/'([^']*)'/g, '$1');
}

function mockExec(cmd: string): string {
  execCalls.push(cmd);
  const flat = unquote(cmd);
  for (const { match, respond } of execRegistry) {
    if (cmd.includes(match) || flat.includes(match)) {
      return typeof respond === 'function' ? respond() : respond;
    }
  }
  const err = new Error(`Unexpected exec call: ${cmd}`) as ThrowableError;
  err.stderr = `Unexpected exec call: ${cmd}`;
  err.status = 127;
  throw err;
}

mock.module('child_process', () => ({
  execSync: (cmd: string, _opts?: unknown) => mockExec(cmd),
}));

const { default: handler } = await import('../handlers/pr_create.ts');

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

function onExec(match: string, respond: Responder) {
  execRegistry.push({ match, respond });
}

// Locate a recorded call whose unquoted form contains `needle`. Returns the
// raw (still-quoted) call so flag-presence assertions still see the literal
// argv (e.g. `--draft`, `--repo`, `'main'`).
function findCall(needle: string): string {
  return execCalls.find((c) => c.includes(needle) || unquote(c).includes(needle)) ?? '';
}

function failExec(match: string, stderr: string, status: number = 1): void {
  onExec(match, () => {
    const err = new Error(stderr) as ThrowableError;
    err.stderr = stderr;
    err.stdout = '';
    err.status = status;
    throw err;
  });
}

beforeEach(() => {
  execRegistry = [];
  execCalls = [];
});

afterEach(() => {
  execRegistry = [];
  execCalls = [];
});

describe('pr_create handler', () => {
  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('pr_create');
    expect(typeof handler.execute).toBe('function');
  });

  test('github_happy_path — creates PR and returns normalized response', async () => {
    onExec('git remote get-url origin', 'git@github.com:org/repo.git\n');
    onExec('git branch --show-current', 'feature/76-pr-create\n');
    onExec('gh pr create', 'https://github.com/org/repo/pull/42\n');
    onExec(
      'gh pr view',
      JSON.stringify({
        number: 42,
        url: 'https://github.com/org/repo/pull/42',
        state: 'OPEN',
        headRefName: 'feature/76-pr-create',
        baseRefName: 'main',
      }),
    );

    const result = await handler.execute({
      title: 'feat: add pr_create',
      body: 'Implements the pr_create handler.',
      base: 'main',
    });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.number).toBe(42);
    expect(data.url).toBe('https://github.com/org/repo/pull/42');
    expect(data.state).toBe('open');
    expect(data.head).toBe('feature/76-pr-create');
    expect(data.base).toBe('main');
    expect(data.created).toBe(true);
  });

  test('gitlab_happy_path — creates MR and returns normalized response', async () => {
    onExec('git remote get-url origin', 'git@gitlab.com:org/repo.git\n');
    onExec('git branch --show-current', 'feature/76-pr-create\n');
    onExec('glab mr create', 'https://gitlab.com/org/repo/-/merge_requests/7\n');
    onExec(
      'glab mr view',
      JSON.stringify({
        iid: 7,
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/7',
        state: 'opened',
        source_branch: 'feature/76-pr-create',
        target_branch: 'main',
      }),
    );

    const result = await handler.execute({
      title: 'feat: add pr_create',
      body: 'Implements the pr_create handler.',
      base: 'main',
    });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.number).toBe(7);
    expect(data.url).toBe('https://gitlab.com/org/repo/-/merge_requests/7');
    expect(data.state).toBe('open');
    expect(data.head).toBe('feature/76-pr-create');
    expect(data.base).toBe('main');
    expect(data.created).toBe(true);
  });

  test('draft_flag_github — passes --draft to gh pr create', async () => {
    onExec('git remote get-url origin', 'git@github.com:org/repo.git\n');
    onExec('git branch --show-current', 'feature/76-pr-create\n');
    onExec('gh pr create', 'https://github.com/org/repo/pull/99\n');
    onExec(
      'gh pr view',
      JSON.stringify({
        number: 99,
        url: 'https://github.com/org/repo/pull/99',
        state: 'OPEN',
        headRefName: 'feature/76-pr-create',
        baseRefName: 'main',
      }),
    );

    const result = await handler.execute({
      title: 't',
      body: 'b',
      base: 'main',
      draft: true,
    });
    const data = parseResult(result);
    expect(data.ok).toBe(true);

    const createCall = findCall('gh pr create');
    expect(createCall).toContain('--draft');
  });

  test('draft_flag_gitlab — passes --draft to glab mr create', async () => {
    onExec('git remote get-url origin', 'git@gitlab.com:org/repo.git\n');
    onExec('git branch --show-current', 'feature/76-pr-create\n');
    onExec('glab mr create', 'https://gitlab.com/org/repo/-/merge_requests/8\n');
    onExec(
      'glab mr view',
      JSON.stringify({
        iid: 8,
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/8',
        state: 'opened',
        source_branch: 'feature/76-pr-create',
        target_branch: 'main',
      }),
    );

    const result = await handler.execute({
      title: 't',
      body: 'b',
      base: 'main',
      draft: true,
    });
    const data = parseResult(result);
    expect(data.ok).toBe(true);

    const createCall = findCall('glab mr create');
    expect(createCall).toContain('--draft');
  });

  test('missing_required_title — schema rejects', async () => {
    const result = await handler.execute({ body: 'b', base: 'main' });
    const data = parseResult(result);
    expect(data.ok).toBe(false);
    expect(String(data.error)).toContain('title');
  });

  test('missing_required_body — schema rejects', async () => {
    const result = await handler.execute({ title: 't', base: 'main' });
    const data = parseResult(result);
    expect(data.ok).toBe(false);
    expect(String(data.error)).toContain('body');
  });

  // ---- #159: auto-resolve default branch when base is omitted ------------

  test('default_branch_resolution_github — base omitted resolves via gh repo view', async () => {
    onExec('git remote get-url origin', 'git@github.com:org/repo.git\n');
    onExec('git branch --show-current', 'feature/159-default-branch\n');
    // gh repo view --json defaultBranchRef --jq .defaultBranchRef.name
    onExec('gh repo view', 'main\n');
    onExec('gh pr create', 'https://github.com/org/repo/pull/42\n');
    onExec(
      'gh pr view',
      JSON.stringify({
        number: 42,
        url: 'https://github.com/org/repo/pull/42',
        state: 'OPEN',
        headRefName: 'feature/159-default-branch',
        baseRefName: 'main',
      }),
    );

    const result = await handler.execute({
      title: 'feat: default branch',
      body: 'Body',
      // base intentionally omitted
    });
    const data = parseResult(result);
    expect(data.ok).toBe(true);
    expect(data.base).toBe('main');

    // Verify default-branch resolution propagated into the create call.
    const createCall = findCall('gh pr create');
    expect(createCall).toContain('--base');
    expect(createCall).toContain("'main'");
  });

  test('default_branch_resolution_gitlab — base omitted resolves via glab api', async () => {
    onExec('git remote get-url origin', 'git@gitlab.com:org/repo.git\n');
    onExec('git branch --show-current', 'feature/159-default-branch\n');
    // glab api projects/:id — no --jq flag (handler parses JSON in-process).
    onExec('glab api', () => {
      // Faithful to the real glab binary — fail loudly if the handler ever
      // passes --jq. Look at the most recent recorded call.
      const last = execCalls[execCalls.length - 1] ?? '';
      if (last.includes('--jq')) {
        const err = new Error('FAIL: glab api does not accept --jq') as ThrowableError;
        err.stderr = 'FAIL: glab api does not accept --jq';
        err.status = 99;
        throw err;
      }
      return JSON.stringify({
        id: 42,
        name: 'repo',
        default_branch: 'develop',
        path_with_namespace: 'org/repo',
      });
    });
    onExec('glab mr create', 'https://gitlab.com/org/repo/-/merge_requests/7\n');
    onExec(
      'glab mr view',
      JSON.stringify({
        iid: 7,
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/7',
        state: 'opened',
        source_branch: 'feature/159-default-branch',
        target_branch: 'develop',
      }),
    );

    const result = await handler.execute({
      title: 'feat: default branch',
      body: 'Body',
    });
    const data = parseResult(result);
    expect(data.ok).toBe(true);
    expect(data.base).toBe('develop');

    const createCall = findCall('glab mr create');
    expect(createCall).toContain('--target-branch');
    expect(createCall).toContain("'develop'");
  });

  test('explicit_base_wins — auto-resolution skipped when base is provided', async () => {
    onExec('git remote get-url origin', 'git@github.com:org/repo.git\n');
    onExec('git branch --show-current', 'feature/159-default-branch\n');
    // gh repo view MUST NOT be called when explicit base provided — fail loudly.
    failExec('gh repo view', 'FAIL: repo view should not be called with explicit base', 99);
    onExec('gh pr create', 'https://github.com/org/repo/pull/77\n');
    onExec(
      'gh pr view',
      JSON.stringify({
        number: 77,
        url: 'https://github.com/org/repo/pull/77',
        state: 'OPEN',
        headRefName: 'feature/159-default-branch',
        baseRefName: 'release/v2',
      }),
    );

    const result = await handler.execute({
      title: 'feat: explicit base',
      body: 'Body',
      base: 'release/v2',
    });
    const data = parseResult(result);
    expect(data.ok).toBe(true);
    expect(data.base).toBe('release/v2');

    // Confirm gh repo view was never called.
    expect(execCalls.some((c) => c.includes('gh repo view'))).toBe(false);
  });

  test('default_branch_resolution_failure — surfaces ok:false when gh repo view fails', async () => {
    onExec('git remote get-url origin', 'git@github.com:org/repo.git\n');
    onExec('git branch --show-current', 'feature/159-default-branch\n');
    failExec('gh repo view', 'auth required');

    const result = await handler.execute({
      title: 'feat: no base',
      body: 'Body',
    });
    const data = parseResult(result);
    expect(data.ok).toBe(false);
    expect(String(data.error)).toContain('default branch');
  });

  test('explicit_head_overrides_git_branch — uses args.head when provided', async () => {
    onExec('git remote get-url origin', 'git@github.com:org/repo.git\n');
    // git branch should NOT be called when head is provided — fail loudly.
    failExec(
      'git branch --show-current',
      'git branch should not be called when head is provided',
      99,
    );
    onExec('gh pr create', 'https://github.com/org/repo/pull/55\n');
    onExec(
      'gh pr view',
      JSON.stringify({
        number: 55,
        url: 'https://github.com/org/repo/pull/55',
        state: 'OPEN',
        headRefName: 'custom-head',
        baseRefName: 'main',
      }),
    );

    const result = await handler.execute({
      title: 't',
      body: 'b',
      base: 'main',
      head: 'custom-head',
    });
    const data = parseResult(result);
    expect(data.ok).toBe(true);
    expect(data.head).toBe('custom-head');
    expect(execCalls.some((c) => c.includes('git branch --show-current'))).toBe(false);
  });

  test('github_error_path — gh pr create fails, returns ok=false with error', async () => {
    onExec('git remote get-url origin', 'git@github.com:org/repo.git\n');
    onExec('git branch --show-current', 'feature/76-pr-create\n');
    failExec('gh pr create', 'authentication error: not logged in');

    const result = await handler.execute({
      title: 't',
      body: 'b',
      base: 'main',
    });
    const data = parseResult(result);
    expect(data.ok).toBe(false);
    expect(String(data.error)).toContain('gh pr create failed');
    expect(String(data.error)).toContain('authentication error');
  });

  test('github_idempotent — duplicate PR returns existing with created=false', async () => {
    onExec('git remote get-url origin', 'git@github.com:org/repo.git\n');
    onExec('git branch --show-current', 'feature/76-pr-create\n');
    failExec(
      'gh pr create',
      'a pull request for branch "feature/76-pr-create" into branch "main" already exists',
    );
    onExec(
      'gh pr list',
      JSON.stringify([
        {
          number: 42,
          url: 'https://github.com/org/repo/pull/42',
          state: 'OPEN',
          headRefName: 'feature/76-pr-create',
          baseRefName: 'main',
        },
      ]),
    );

    const result = await handler.execute({
      title: 'feat: add pr_create',
      body: 'Implements the pr_create handler.',
      base: 'main',
    });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.number).toBe(42);
    expect(data.url).toBe('https://github.com/org/repo/pull/42');
    expect(data.created).toBe(false);
  });

  test('gitlab_idempotent — duplicate MR returns existing with created=false', async () => {
    onExec('git remote get-url origin', 'git@gitlab.com:org/repo.git\n');
    onExec('git branch --show-current', 'feature/76-pr-create\n');
    failExec(
      'glab mr create',
      'Another open merge request already exists for this source branch',
    );
    onExec(
      'glab mr view',
      JSON.stringify({
        iid: 7,
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/7',
        state: 'opened',
        source_branch: 'feature/76-pr-create',
        target_branch: 'main',
      }),
    );

    const result = await handler.execute({
      title: 'feat: add pr_create',
      body: 'Implements the pr_create handler.',
      base: 'main',
    });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.number).toBe(7);
    expect(data.url).toBe('https://gitlab.com/org/repo/-/merge_requests/7');
    expect(data.created).toBe(false);
  });

  test('route_with_repo_github — appends --repo to gh pr create/view when repo provided', async () => {
    // cwd remote is a DIFFERENT repo — repo arg must override.
    onExec('git remote get-url origin', 'git@github.com:cwd-org/cwd-repo.git\n');
    onExec('git branch --show-current', 'feature/196-cross-repo\n');
    onExec(
      'gh pr create',
      'https://github.com/Wave-Engineering/mcp-server-sdlc/pull/196\n',
    );
    onExec(
      'gh pr view',
      JSON.stringify({
        number: 196,
        url: 'https://github.com/Wave-Engineering/mcp-server-sdlc/pull/196',
        state: 'OPEN',
        headRefName: 'feature/196-cross-repo',
        baseRefName: 'main',
      }),
    );

    const result = await handler.execute({
      title: 't',
      body: 'b',
      base: 'main',
      repo: 'Wave-Engineering/mcp-server-sdlc',
    });
    const data = parseResult(result);
    expect(data.ok).toBe(true);
    expect(data.number).toBe(196);

    const createCall = findCall('gh pr create');
    expect(createCall).toContain('--repo');
    expect(createCall).toContain('Wave-Engineering/mcp-server-sdlc');
    const viewCall = findCall('gh pr view');
    expect(viewCall).toContain('--repo');
    expect(viewCall).toContain('Wave-Engineering/mcp-server-sdlc');
  });

  test('route_with_repo_gitlab — appends -R to glab mr create/view when repo provided', async () => {
    onExec('git remote get-url origin', 'git@gitlab.com:cwd-org/cwd-repo.git\n');
    onExec('git branch --show-current', 'feature/196-cross-repo\n');
    onExec(
      'glab mr create',
      'https://gitlab.com/target-org/target-repo/-/merge_requests/8\n',
    );
    onExec(
      'glab mr view',
      JSON.stringify({
        iid: 8,
        web_url: 'https://gitlab.com/target-org/target-repo/-/merge_requests/8',
        state: 'opened',
        source_branch: 'feature/196-cross-repo',
        target_branch: 'main',
      }),
    );

    const result = await handler.execute({
      title: 't',
      body: 'b',
      base: 'main',
      repo: 'target-org/target-repo',
    });
    const data = parseResult(result);
    expect(data.ok).toBe(true);
    expect(data.number).toBe(8);

    const createCall = findCall('glab mr create');
    expect(createCall).toContain('-R');
    expect(createCall).toContain('target-org/target-repo');
    const viewCall = findCall('glab mr view');
    expect(viewCall).toContain('-R');
    expect(viewCall).toContain('target-org/target-repo');
  });

  test('regression_without_repo — gh pr create argv has no --repo flag', async () => {
    onExec('git remote get-url origin', 'git@github.com:org/repo.git\n');
    onExec('git branch --show-current', 'feature/xyz\n');
    onExec('gh pr create', 'https://github.com/org/repo/pull/100\n');
    onExec(
      'gh pr view',
      JSON.stringify({
        number: 100,
        url: 'https://github.com/org/repo/pull/100',
        state: 'OPEN',
        headRefName: 'feature/xyz',
        baseRefName: 'main',
      }),
    );

    const result = await handler.execute({
      title: 't',
      body: 'b',
      base: 'main',
    });
    const data = parseResult(result);
    expect(data.ok).toBe(true);

    const createCall = findCall('gh pr create');
    expect(createCall).not.toContain('--repo');
  });

  test('invalid_slug_early_error — returns ok:false and does not spawn any subprocess', async () => {
    // No stubs registered — if handler invoked execSync it'd throw via the
    // unmatched-call guard. Zod validation should short-circuit before any
    // subprocess invocation.
    const result = await handler.execute({
      title: 't',
      body: 'b',
      base: 'main',
      repo: 'not-a-slug',
    });
    const data = parseResult(result);
    expect(data.ok).toBe(false);
    expect(String(data.error)).toContain('repo');
    expect(execCalls.length).toBe(0);
  });

  test('fallback_platform_detection — uses git remote URL to route', async () => {
    // Remote URL identifies gitlab — handler must dispatch to glab path.
    onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git\n');
    onExec('git branch --show-current', 'feature/76-pr-create\n');
    onExec('glab mr create', 'https://gitlab.com/org/repo/-/merge_requests/11\n');
    onExec(
      'glab mr view',
      JSON.stringify({
        iid: 11,
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/11',
        state: 'opened',
        source_branch: 'feature/76-pr-create',
        target_branch: 'main',
      }),
    );

    const result = await handler.execute({
      title: 't',
      body: 'b',
      base: 'main',
    });
    const data = parseResult(result);
    expect(data.ok).toBe(true);
    expect(data.number).toBe(11);
  });

  // ---- argv-shape assertion (Story 1.1 unit test ledger) ------------------

  test('execSync invocation matches gh CLI shape', async () => {
    onExec('git remote get-url origin', 'git@github.com:org/repo.git\n');
    onExec('git branch --show-current', 'feature/argv-shape\n');
    onExec('gh pr create', 'https://github.com/org/repo/pull/123\n');
    onExec(
      'gh pr view',
      JSON.stringify({
        number: 123,
        url: 'https://github.com/org/repo/pull/123',
        state: 'OPEN',
        headRefName: 'feature/argv-shape',
        baseRefName: 'main',
      }),
    );

    const result = await handler.execute({
      title: 'feat: shape test',
      body: 'Body text',
      base: 'main',
    });
    const data = parseResult(result);
    expect(data.ok).toBe(true);

    const createCall = findCall('gh pr create');
    // Required flag pairs in any order — argv is shell-quoted in token form
    // ('gh' 'pr' 'create' '--title' 'feat: shape test' ...). Assert presence
    // of every flag and value via the unquoted view.
    expect(createCall.length).toBeGreaterThan(0);
    const flat = unquote(createCall);
    expect(flat).toMatch(/^gh pr create /);
    expect(flat).toContain('--title feat: shape test');
    expect(flat).toContain('--body Body text');
    expect(flat).toContain('--base main');
    expect(flat).toContain('--head feature/argv-shape');
  });
});
