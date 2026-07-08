import { describe, test, expect, beforeEach } from 'bun:test';
import {
  installChildProcessMock,
  onExec,
  resetExecMock,
  execCalls,
} from '../test-support/mock-child-process.ts';
import type { AdapterResult, CheckBranchProtectedResponse } from './types.ts';

// Subprocess-boundary tests for the GitHub checkBranchProtected adapter (#465).

interface ThrowableError extends Error {
  stderr?: string;
  status?: number;
}

installChildProcessMock();

const { checkBranchProtectedGithub } = await import('./check-branch-protected-github.ts');

function expectOk(
  r: AdapterResult<CheckBranchProtectedResponse>,
): asserts r is { ok: true; data: CheckBranchProtectedResponse } {
  if (!('ok' in r) || !r.ok) {
    throw new Error(`expected ok result, got ${JSON.stringify(r)}`);
  }
}

function unquote(cmd: string): string {
  return cmd.replace(/'([^']*)'/g, '$1');
}

function findCall(needle: string): string {
  const raw = execCalls().find((c) => c.includes(needle) || unquote(c).includes(needle)) ?? '';
  return unquote(raw);
}

function fail404(match: string): void {
  onExec(match, () => {
    const e = new Error('not found') as ThrowableError;
    e.stderr = 'gh: Not Found (HTTP 404)';
    e.status = 1;
    throw e;
  });
}

beforeEach(() => {
  resetExecMock();
});

describe('checkBranchProtectedGithub — subprocess boundary', () => {
  test('HTTP 200 ⇒ protected', async () => {
    onExec('branches/main/protection', JSON.stringify({ required_status_checks: { strict: true } }));

    const r = await checkBranchProtectedGithub({ branch: 'main', repo: 'org/repo' });
    expectOk(r);
    expect(r.data.protected).toBe(true);

    const call = findCall('/protection');
    expect(call).toContain('gh api');
    expect(call).toContain('repos/org/repo/branches/main/protection');
  });

  test('HTTP 404 ⇒ not protected', async () => {
    fail404('/protection');

    const r = await checkBranchProtectedGithub({ branch: 'release-legacy', repo: 'org/repo' });
    expectOk(r);
    expect(r.data.protected).toBe(false);
  });

  test('non-404 failure ⇒ ok:false (does NOT collapse to unprotected)', async () => {
    onExec('/protection', () => {
      const e = new Error('bad creds') as ThrowableError;
      e.stderr = 'gh: Bad credentials (HTTP 401)';
      e.status = 1;
      throw e;
    });

    const r = await checkBranchProtectedGithub({ branch: 'main', repo: 'org/repo' });
    expect('ok' in r && r.ok).toBe(false);
    expect((r as { code: string }).code).toBe('gh_protection_check_failed');
  });

  test('omitted repo uses {owner}/{repo} placeholders', async () => {
    onExec('/protection', JSON.stringify({}));

    const r = await checkBranchProtectedGithub({ branch: 'main' });
    expectOk(r);
    expect(findCall('/protection')).toContain('repos/{owner}/{repo}/branches/main/protection');
  });

  test('rejects invalid branch characters (no exec)', async () => {
    const r = await checkBranchProtectedGithub({ branch: 'bad; rm -rf /', repo: 'org/repo' });
    expect('ok' in r && r.ok).toBe(false);
    expect((r as { code: string }).code).toBe('invalid_branch');
    expect(execCalls().length).toBe(0);
  });

  test('rejects invalid repo slug (no exec)', async () => {
    const r = await checkBranchProtectedGithub({ branch: 'main', repo: 'no-slash' });
    expect('ok' in r && r.ok).toBe(false);
    expect((r as { code: string }).code).toBe('invalid_repo');
    expect(execCalls().length).toBe(0);
  });
});
