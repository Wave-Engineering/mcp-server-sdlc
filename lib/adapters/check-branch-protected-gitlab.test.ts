import { describe, test, expect, beforeEach } from 'bun:test';
import {
  installChildProcessMock,
  setExecMock,
  resetExecMock,
  execCalls,
} from '../test-support/mock-child-process.ts';
import type { AdapterResult, CheckBranchProtectedResponse } from './types.ts';

// Subprocess-boundary tests for the GitLab checkBranchProtected adapter (#465).
// Drives the whole path including the `gitlabApiProtectedBranch` wrapper.

interface ThrowableError extends Error {
  stderr?: string;
  status?: number;
}

installChildProcessMock();

const { checkBranchProtectedGitlab } = await import('./check-branch-protected-gitlab.ts');

function expectOk(
  r: AdapterResult<CheckBranchProtectedResponse>,
): asserts r is { ok: true; data: CheckBranchProtectedResponse } {
  if (!('ok' in r) || !r.ok) {
    throw new Error(`expected ok result, got ${JSON.stringify(r)}`);
  }
}

const GITLAB_ORIGIN = 'https://gitlab.com/cwd-org/cwd-repo.git\n';

beforeEach(() => {
  resetExecMock();
});

describe('checkBranchProtectedGitlab — subprocess boundary', () => {
  test('HTTP 200 ⇒ protected', async () => {
    setExecMock((cmd: string) => {
      if (cmd.includes('git remote get-url origin')) return GITLAB_ORIGIN;
      if (cmd.includes('protected_branches')) return JSON.stringify({ name: 'main' });
      return '';
    });

    const r = await checkBranchProtectedGitlab({ branch: 'main' });
    expectOk(r);
    expect(r.data.protected).toBe(true);
  });

  test('HTTP 404 ⇒ not protected', async () => {
    setExecMock((cmd: string) => {
      if (cmd.includes('git remote get-url origin')) return GITLAB_ORIGIN;
      if (cmd.includes('protected_branches')) {
        const e = new Error('nf') as ThrowableError;
        e.stderr = '{"message":"404 Not Found"}';
        e.status = 1;
        throw e;
      }
      return '';
    });

    const r = await checkBranchProtectedGitlab({ branch: 'release/legacy' });
    expectOk(r);
    expect(r.data.protected).toBe(false);
  });

  test('non-404 failure ⇒ ok:false (does NOT collapse to unprotected)', async () => {
    setExecMock((cmd: string) => {
      if (cmd.includes('git remote get-url origin')) return GITLAB_ORIGIN;
      if (cmd.includes('protected_branches')) {
        const e = new Error('unauth') as ThrowableError;
        e.stderr = '401 Unauthorized';
        e.status = 1;
        throw e;
      }
      return '';
    });

    const r = await checkBranchProtectedGitlab({ branch: 'main' });
    expect('ok' in r && r.ok).toBe(false);
    expect((r as { code: string }).code).toBe('glab_protection_check_failed');
  });

  test('URL-encodes an explicit slug into the protected_branches path', async () => {
    let seen = '';
    setExecMock((cmd: string) => {
      if (cmd.includes('protected_branches')) {
        seen = cmd;
        return JSON.stringify({ name: 'main' });
      }
      if (cmd.includes('git remote get-url origin')) return GITLAB_ORIGIN;
      return '';
    });

    const r = await checkBranchProtectedGitlab({ branch: 'main', repo: 'org/repo' });
    expectOk(r);
    expect(seen).toContain('projects/org%2Frepo/protected_branches/main');
  });

  test('rejects invalid branch characters (no exec)', async () => {
    setExecMock(() => '');
    const r = await checkBranchProtectedGitlab({ branch: 'bad; rm -rf /' });
    expect('ok' in r && r.ok).toBe(false);
    expect((r as { code: string }).code).toBe('invalid_branch');
    expect(execCalls().length).toBe(0);
  });
});
