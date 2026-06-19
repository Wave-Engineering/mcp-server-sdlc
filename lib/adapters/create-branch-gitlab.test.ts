import { describe, test, expect, beforeEach } from 'bun:test';
import type { AdapterResult } from './types.ts';
import {
  installChildProcessMock,
  onExec,
  resetExecMock,
  execCalls,
} from '../test-support/mock-child-process.ts';

// Subprocess-boundary tests for the GitLab createBranch adapter (R-15).

interface ThrowableError extends Error {
  stderr?: string;
  stdout?: string;
  status?: number;
}

function unquote(cmd: string): string {
  return cmd.replace(/'([^']*)'/g, '$1');
}

installChildProcessMock();

const { createBranchGitlab } = await import('./create-branch-gitlab.ts');

function expectOk(r: AdapterResult<void>): asserts r is { ok: true; data: void } {
  if (!('ok' in r) || !r.ok) {
    throw new Error(`expected ok result, got ${JSON.stringify(r)}`);
  }
}

function findCall(needle: string): string {
  return execCalls().find((c) => c.includes(needle) || unquote(c).includes(needle)) ?? '';
}

const VALID_SHA = 'b'.repeat(40);

beforeEach(() => {
  resetExecMock();
});

describe('createBranchGitlab — subprocess boundary', () => {
  test('argv: glab api projects/<encoded>/repository/branches -X POST -f branch=<name> -f ref=<sha>', async () => {
    onExec('glab api projects/my-group%2Fmy-repo/repository/branches', '');

    const result = await createBranchGitlab({
      branch: 'kahuna/7-feature-x',
      sha: VALID_SHA,
      repo: 'my-group/my-repo',
    });
    expectOk(result);

    const call = findCall('glab api');
    expect(call).toContain('projects/my-group%2Fmy-repo/repository/branches');
    expect(call).toContain('-X');
    expect(call).toContain('POST');
    const flat = unquote(call);
    expect(flat).toContain('branch=kahuna/7-feature-x');
    expect(flat).toContain(`ref=${VALID_SHA}`);
  });

  test('void return on success', async () => {
    onExec('glab api', '');
    const result = await createBranchGitlab({
      branch: 'feature/1-demo',
      sha: VALID_SHA,
      repo: 'org/repo',
    });
    expectOk(result);
    expect(result.data).toBeUndefined();
  });

  test('returns ok:false when glab exits non-zero', async () => {
    onExec('glab api', () => {
      const err = new Error('glab: Branch already exists') as ThrowableError;
      err.stderr = 'Branch already exists';
      err.status = 1;
      throw err;
    });

    const result = await createBranchGitlab({
      branch: 'kahuna/1-foo',
      sha: VALID_SHA,
      repo: 'org/repo',
    });
    expect('ok' in result && result.ok).toBe(false);
    expect((result as { code: string }).code).toBe('glab_create_branch_failed');
    expect((result as { error: string }).error).toContain('kahuna/1-foo');
  });

  test('does NOT pass -R flag (glab api is path-resolved)', async () => {
    onExec('glab api', '');
    await createBranchGitlab({
      branch: 'kahuna/1-foo',
      sha: VALID_SHA,
      repo: 'org/repo',
    });
    const call = findCall('glab api');
    // Extract argv-like tokens; the command format uses "-X POST" but never
    // "-R <slug>" — the slug lives in the URL path, not as a porcelain flag.
    const postR = call.match(/\s-R\s/);
    expect(postR).toBeNull();
  });

  test('rejects invalid branch characters', async () => {
    const result = await createBranchGitlab({
      branch: 'bad; rm -rf /',
      sha: VALID_SHA,
      repo: 'org/repo',
    });
    expect('ok' in result && result.ok).toBe(false);
    expect((result as { code: string }).code).toBe('invalid_branch');
    expect(execCalls().length).toBe(0);
  });

  test('rejects invalid sha', async () => {
    const result = await createBranchGitlab({
      branch: 'main',
      sha: 'not-a-sha',
      repo: 'org/repo',
    });
    expect('ok' in result && result.ok).toBe(false);
    expect((result as { code: string }).code).toBe('invalid_sha');
    expect(execCalls().length).toBe(0);
  });

  test('rejects invalid repo slug', async () => {
    const result = await createBranchGitlab({
      branch: 'main',
      sha: VALID_SHA,
      repo: 'no-slash',
    });
    expect('ok' in result && result.ok).toBe(false);
    expect((result as { code: string }).code).toBe('invalid_repo');
    expect(execCalls().length).toBe(0);
  });

  test('supports nested group slugs (org/sub/repo → org%2Fsub%2Frepo)', async () => {
    onExec('glab api projects/org%2Fsub%2Frepo/repository/branches', '');

    const result = await createBranchGitlab({
      branch: 'kahuna/1-foo',
      sha: VALID_SHA,
      repo: 'org/sub/repo',
    });
    expectOk(result);
    const call = findCall('glab api');
    expect(call).toContain('projects/org%2Fsub%2Frepo/repository/branches');
  });
});
