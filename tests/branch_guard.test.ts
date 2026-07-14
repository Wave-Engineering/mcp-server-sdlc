import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  installChildProcessMock,
  onExec,
  resetExecMock,
  execCalls,
} from '../lib/test-support/mock-child-process.ts';

// branch_guard handler tests (#465, #470). Drives the REAL adapters through the
// shared child_process mock — same convention as tests/pr_create.test.ts.
//
// #470: protection is a NAME convention (main | release/*), resolved in the
// handler — so verdict tests need NO protection-endpoint mocking. The only host
// call in the target-role path is resolveDefaultBranch (gh repo view / glab api
// projects/:id). An unmatched exec throws, so a stray host query surfaces loudly.

installChildProcessMock();

const { default: handler } = await import('../handlers/branch_guard.ts');

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

const GITHUB_ORIGIN = 'git@github.com:org/repo.git\n';
const GITLAB_ORIGIN = 'git@gitlab.com:org/repo.git\n';

beforeEach(() => resetExecMock());
afterEach(() => resetExecMock());

describe('branch_guard handler — shape', () => {
  test('exports a valid HandlerDef', () => {
    expect(handler.name).toBe('branch_guard');
    expect(typeof handler.execute).toBe('function');
  });

  test('rejects missing role via schema (no subprocess)', async () => {
    const data = parseResult(await handler.execute({}));
    expect(data.ok).toBe(false);
    expect(String(data.error)).toContain('role');
    expect(execCalls().length).toBe(0);
  });

  test('rejects an invalid repo slug via schema (no subprocess)', async () => {
    const data = parseResult(
      await handler.execute({ role: 'target', branch: 'main', repo: 'not-a-slug' }),
    );
    expect(data.ok).toBe(false);
    expect(String(data.error)).toContain('repo');
    expect(execCalls().length).toBe(0);
  });
});

describe('branch_guard verdicts — GitHub (name-based protection)', () => {
  test('default branch (main) → pass', async () => {
    onExec('git remote get-url origin', GITHUB_ORIGIN);
    onExec('gh repo view', 'main\n');

    const data = parseResult(await handler.execute({ role: 'target', branch: 'main' }));
    expect(data.ok).toBe(true);
    expect(data.verdict).toBe('pass');
    expect(data.default_branch).toBe('main');
    expect(data.checked_branch).toBe('main');
    expect(data.is_protected).toBe(true);
    expect(data.is_sandbox).toBe(false);
  });

  test('old release/0.0.1 while default is release/1.0.0 → warn (LTS scenario)', async () => {
    onExec('git remote get-url origin', GITHUB_ORIGIN);
    onExec('gh repo view', 'release/1.0.0\n');

    const data = parseResult(await handler.execute({ role: 'target', branch: 'release/0.0.1' }));
    expect(data.ok).toBe(true);
    expect(data.verdict).toBe('warn');
    expect(data.default_branch).toBe('release/1.0.0');
    expect(data.checked_branch).toBe('release/0.0.1');
    expect(data.is_protected).toBe(true);
    expect(data.is_sandbox).toBe(false);
  });

  test('release/1.0.0 when it IS the default → pass', async () => {
    onExec('git remote get-url origin', GITHUB_ORIGIN);
    onExec('gh repo view', 'release/1.0.0\n');

    const data = parseResult(await handler.execute({ role: 'target', branch: 'release/1.0.0' }));
    expect(data.ok).toBe(true);
    expect(data.verdict).toBe('pass');
    expect(data.is_protected).toBe(true);
  });

  test('main when the default is a release branch → warn (protected by name, not default)', async () => {
    onExec('git remote get-url origin', GITHUB_ORIGIN);
    onExec('gh repo view', 'release/1.0.0\n');

    const data = parseResult(await handler.execute({ role: 'target', branch: 'main' }));
    expect(data.ok).toBe(true);
    expect(data.verdict).toBe('warn');
    expect(data.default_branch).toBe('release/1.0.0');
    expect(data.checked_branch).toBe('main');
    expect(data.is_protected).toBe(true);
  });

  test('kahuna/12-x → pass (is_sandbox true)', async () => {
    onExec('git remote get-url origin', GITHUB_ORIGIN);
    onExec('gh repo view', 'main\n');

    const data = parseResult(await handler.execute({ role: 'target', branch: 'kahuna/12-x' }));
    expect(data.ok).toBe(true);
    expect(data.verdict).toBe('pass');
    expect(data.is_sandbox).toBe(true);
    expect(data.checked_branch).toBe('kahuna/12-x');
  });

  test('feature/x → pass (not a protected branch name)', async () => {
    onExec('git remote get-url origin', GITHUB_ORIGIN);
    onExec('gh repo view', 'main\n');

    const data = parseResult(await handler.execute({ role: 'target', branch: 'feature/x' }));
    expect(data.ok).toBe(true);
    expect(data.verdict).toBe('pass');
    expect(data.is_protected).toBe(false);
    expect(data.is_sandbox).toBe(false);
  });

  test('target with base omitted → the live default (pass)', async () => {
    onExec('git remote get-url origin', GITHUB_ORIGIN);
    onExec('gh repo view', 'main\n');

    const data = parseResult(await handler.execute({ role: 'target' }));
    expect(data.ok).toBe(true);
    expect(data.verdict).toBe('pass');
    expect(data.checked_branch).toBe('main');
  });
});

describe('branch_guard verdicts — GitLab (name-based protection)', () => {
  test('default branch (main) → pass', async () => {
    onExec('git remote get-url origin', GITLAB_ORIGIN);
    onExec('projects/:id', JSON.stringify({ default_branch: 'main' }));

    const data = parseResult(await handler.execute({ role: 'target', branch: 'main' }));
    expect(data.ok).toBe(true);
    expect(data.verdict).toBe('pass');
    expect(data.default_branch).toBe('main');
    expect(data.is_protected).toBe(true);
  });

  test('old release/0.0.1 while default is release/1.0.0 → warn (LTS scenario)', async () => {
    onExec('git remote get-url origin', GITLAB_ORIGIN);
    onExec('projects/:id', JSON.stringify({ default_branch: 'release/1.0.0' }));

    const data = parseResult(await handler.execute({ role: 'target', branch: 'release/0.0.1' }));
    expect(data.ok).toBe(true);
    expect(data.verdict).toBe('warn');
    expect(data.default_branch).toBe('release/1.0.0');
    expect(data.is_protected).toBe(true);
  });

  test('kahuna/9-foo → pass (is_sandbox true)', async () => {
    onExec('git remote get-url origin', GITLAB_ORIGIN);
    onExec('projects/:id', JSON.stringify({ default_branch: 'main' }));

    const data = parseResult(await handler.execute({ role: 'target', branch: 'kahuna/9-foo' }));
    expect(data.ok).toBe(true);
    expect(data.verdict).toBe('pass');
    expect(data.is_sandbox).toBe(true);
  });

  test('feature/x → pass (not a protected branch name)', async () => {
    onExec('git remote get-url origin', GITLAB_ORIGIN);
    onExec('projects/:id', JSON.stringify({ default_branch: 'main' }));

    const data = parseResult(await handler.execute({ role: 'target', branch: 'feature/x' }));
    expect(data.ok).toBe(true);
    expect(data.verdict).toBe('pass');
    expect(data.is_protected).toBe(false);
  });
});

describe('branch_guard role=base — base detection via open PR', () => {
  test('open PR base is the live default → pass', async () => {
    onExec('git remote get-url origin', GITHUB_ORIGIN);
    onExec('gh repo view', 'main\n');
    onExec('git branch --show-current', 'feature/470-name-based\n');
    onExec(
      'gh pr list',
      JSON.stringify([
        {
          number: 5,
          title: 't',
          state: 'OPEN',
          headRefName: 'feature/470-name-based',
          baseRefName: 'main',
          url: 'https://github.com/org/repo/pull/5',
        },
      ]),
    );

    const data = parseResult(await handler.execute({ role: 'base' }));
    expect(data.ok).toBe(true);
    expect(data.verdict).toBe('pass');
    expect(data.checked_branch).toBe('main');
  });

  test('open PR based on an OLD release branch → warn', async () => {
    onExec('git remote get-url origin', GITHUB_ORIGIN);
    onExec('gh repo view', 'release/1.0.0\n');
    onExec('git branch --show-current', 'feature/470-name-based\n');
    onExec(
      'gh pr list',
      JSON.stringify([
        {
          number: 6,
          title: 't',
          state: 'OPEN',
          headRefName: 'feature/470-name-based',
          baseRefName: 'release/0.0.1',
          url: 'https://github.com/org/repo/pull/6',
        },
      ]),
    );

    const data = parseResult(await handler.execute({ role: 'base' }));
    expect(data.ok).toBe(true);
    expect(data.verdict).toBe('warn');
    expect(data.checked_branch).toBe('release/0.0.1');
    expect(data.is_protected).toBe(true);
  });

  test('no open PR → pass (base undetermined pre-PR, never a false warn)', async () => {
    onExec('git remote get-url origin', GITHUB_ORIGIN);
    onExec('gh repo view', 'main\n');
    onExec('git branch --show-current', 'feature/470-name-based\n');
    onExec('gh pr list', '[]');

    const data = parseResult(await handler.execute({ role: 'base' }));
    expect(data.ok).toBe(true);
    expect(data.verdict).toBe('pass');
    expect(data.checked_branch).toBe('feature/470-name-based');
    expect(data.is_protected).toBe(false);
    expect(String(data.reason)).toContain('No open PR');
  });

  test('repo set + no branch → refuse, never a cwd-branch lookup in the wrong repo (#480)', async () => {
    onExec('git remote get-url origin', GITHUB_ORIGIN);
    onExec('git branch --show-current', 'feature/470-name-based\n');
    // Deliberately NO `gh repo view` / `gh pr list` mocks: the guard must refuse
    // BEFORE any base-resolution work. If the guard is removed the handler falls
    // through to resolveDefaultBranch/prList (unmocked) and this assertion goes red.

    const data = parseResult(
      await handler.execute({ role: 'base', repo: 'someorg/unrelated' }),
    );
    expect(data.ok).toBe(false);
    expect(String(data.error)).toContain("no 'branch'");
    expect(String(data.error)).toContain('someorg/unrelated');
    // The whole point: we never looked up the cwd branch's base in the foreign repo.
    expect(execCalls().some((c) => c.includes('pr list'))).toBe(false);
  });
});
