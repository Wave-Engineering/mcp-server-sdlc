import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  installChildProcessMock,
  onExec,
  resetExecMock,
  execCalls,
} from '../lib/test-support/mock-child-process.ts';

// branch_guard handler tests (#465). Drives the REAL adapters through the shared
// child_process mock — same convention as tests/pr_create.test.ts. Each test
// registers substring → responder mappings via `onExec`; an unmatched call
// throws, so a missing stub (e.g. an unexpected protection query on a sandbox
// branch) surfaces loudly as a failure.

interface ThrowableError extends Error {
  stderr?: string;
  stdout?: string;
  status?: number;
}

installChildProcessMock();

const { default: handler } = await import('../handlers/branch_guard.ts');

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

function fail404(match: string): void {
  onExec(match, () => {
    const err = new Error('not found') as ThrowableError;
    err.stderr = 'gh: Not Found (HTTP 404)';
    err.status = 1;
    throw err;
  });
}

function failGlab404(match: string): void {
  onExec(match, () => {
    const err = new Error('nf') as ThrowableError;
    err.stderr = '{"message":"404 Not Found"}';
    err.status = 1;
    throw err;
  });
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

describe('branch_guard verdicts — GitHub', () => {
  test('default branch → pass', async () => {
    onExec('git remote get-url origin', GITHUB_ORIGIN);
    onExec('gh repo view', 'main\n');
    onExec('branches/main/protection', JSON.stringify({ required_status_checks: { strict: true } }));

    const data = parseResult(await handler.execute({ role: 'target', branch: 'main' }));
    expect(data.ok).toBe(true);
    expect(data.verdict).toBe('pass');
    expect(data.default_branch).toBe('main');
    expect(data.checked_branch).toBe('main');
    expect(data.is_protected).toBe(true);
    expect(data.is_sandbox).toBe(false);
  });

  test('kahuna/12-foo → pass (is_sandbox true, protection NOT queried)', async () => {
    onExec('git remote get-url origin', GITHUB_ORIGIN);
    onExec('gh repo view', 'main\n');
    // No protection stub: if the handler queries it, the unmatched-call guard
    // throws — asserting the sandbox carve-out short-circuits before the gate.

    const data = parseResult(await handler.execute({ role: 'target', branch: 'kahuna/12-foo' }));
    expect(data.ok).toBe(true);
    expect(data.verdict).toBe('pass');
    expect(data.is_sandbox).toBe(true);
    expect(data.checked_branch).toBe('kahuna/12-foo');
  });

  test('unprotected non-default branch → pass', async () => {
    onExec('git remote get-url origin', GITHUB_ORIGIN);
    onExec('gh repo view', 'main\n');
    fail404('branches/develop/protection');

    const data = parseResult(await handler.execute({ role: 'target', branch: 'develop' }));
    expect(data.ok).toBe(true);
    expect(data.verdict).toBe('pass');
    expect(data.is_protected).toBe(false);
    expect(data.is_sandbox).toBe(false);
  });

  test('protected non-default non-kahuna branch → warn', async () => {
    onExec('git remote get-url origin', GITHUB_ORIGIN);
    onExec('gh repo view', 'main\n');
    onExec('branches/release-1.0/protection', JSON.stringify({ required_status_checks: { strict: true } }));

    const data = parseResult(await handler.execute({ role: 'target', branch: 'release-1.0' }));
    expect(data.ok).toBe(true);
    expect(data.verdict).toBe('warn');
    expect(data.is_protected).toBe(true);
    expect(data.is_sandbox).toBe(false);
    expect(String(data.reason)).toContain('stale or renamed');
  });

  test('target with base omitted → the live default (pass)', async () => {
    onExec('git remote get-url origin', GITHUB_ORIGIN);
    onExec('gh repo view', 'main\n');
    onExec('branches/main/protection', JSON.stringify({}));

    const data = parseResult(await handler.execute({ role: 'target' }));
    expect(data.ok).toBe(true);
    expect(data.verdict).toBe('pass');
    expect(data.checked_branch).toBe('main');
  });
});

describe('branch_guard verdicts — GitLab', () => {
  test('default branch → pass', async () => {
    onExec('git remote get-url origin', GITLAB_ORIGIN);
    onExec('projects/:id', JSON.stringify({ default_branch: 'main' }));
    onExec('protected_branches/main', JSON.stringify({ name: 'main' }));

    const data = parseResult(await handler.execute({ role: 'target', branch: 'main' }));
    expect(data.ok).toBe(true);
    expect(data.verdict).toBe('pass');
    expect(data.default_branch).toBe('main');
    expect(data.is_protected).toBe(true);
  });

  test('kahuna/9-foo → pass (is_sandbox true, protection NOT queried)', async () => {
    onExec('git remote get-url origin', GITLAB_ORIGIN);
    onExec('projects/:id', JSON.stringify({ default_branch: 'main' }));

    const data = parseResult(await handler.execute({ role: 'target', branch: 'kahuna/9-foo' }));
    expect(data.ok).toBe(true);
    expect(data.verdict).toBe('pass');
    expect(data.is_sandbox).toBe(true);
  });

  test('unprotected non-default branch → pass', async () => {
    onExec('git remote get-url origin', GITLAB_ORIGIN);
    onExec('projects/:id', JSON.stringify({ default_branch: 'main' }));
    failGlab404('protected_branches/develop');

    const data = parseResult(await handler.execute({ role: 'target', branch: 'develop' }));
    expect(data.ok).toBe(true);
    expect(data.verdict).toBe('pass');
    expect(data.is_protected).toBe(false);
  });

  test('protected non-default non-kahuna branch → warn', async () => {
    onExec('git remote get-url origin', GITLAB_ORIGIN);
    onExec('projects/:id', JSON.stringify({ default_branch: 'main' }));
    onExec('protected_branches/release-1.0', JSON.stringify({ name: 'release-1.0' }));

    const data = parseResult(await handler.execute({ role: 'target', branch: 'release-1.0' }));
    expect(data.ok).toBe(true);
    expect(data.verdict).toBe('warn');
    expect(data.is_protected).toBe(true);
    expect(String(data.reason)).toContain('stale or renamed');
  });
});

describe('branch_guard role=base — base detection via open PR', () => {
  test('open PR base resolves to the live default → pass', async () => {
    onExec('git remote get-url origin', GITHUB_ORIGIN);
    onExec('gh repo view', 'main\n');
    onExec('git branch --show-current', 'feature/465-branch-guard\n');
    onExec(
      'gh pr list',
      JSON.stringify([
        {
          number: 5,
          title: 't',
          state: 'OPEN',
          headRefName: 'feature/465-branch-guard',
          baseRefName: 'main',
          url: 'https://github.com/org/repo/pull/5',
        },
      ]),
    );
    onExec('branches/main/protection', JSON.stringify({ required_status_checks: { strict: true } }));

    const data = parseResult(await handler.execute({ role: 'base' }));
    expect(data.ok).toBe(true);
    expect(data.verdict).toBe('pass');
    expect(data.checked_branch).toBe('main');
  });

  test('no open PR → pass (base undetermined pre-PR, never a false warn)', async () => {
    onExec('git remote get-url origin', GITHUB_ORIGIN);
    onExec('gh repo view', 'main\n');
    onExec('git branch --show-current', 'feature/465-branch-guard\n');
    onExec('gh pr list', '[]');
    // No protection stub: the no-PR path must early-return before any gate.

    const data = parseResult(await handler.execute({ role: 'base' }));
    expect(data.ok).toBe(true);
    expect(data.verdict).toBe('pass');
    expect(data.checked_branch).toBe('feature/465-branch-guard');
    expect(data.is_protected).toBe(false);
    expect(String(data.reason)).toContain('No open PR');
  });
});
