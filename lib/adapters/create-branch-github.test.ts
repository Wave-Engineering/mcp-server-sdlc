import { describe, test, expect, beforeEach } from 'bun:test';
import type { AdapterResult } from './types.ts';
import {
  installChildProcessMock,
  onExec,
  resetExecMock,
  execCalls,
} from '../test-support/mock-child-process.ts';

// Subprocess-boundary tests for the GitHub createBranch adapter (R-15).

interface ThrowableError extends Error {
  stderr?: string;
  stdout?: string;
  status?: number;
}

function unquote(cmd: string): string {
  return cmd.replace(/'([^']*)'/g, '$1');
}

installChildProcessMock();

const { createBranchGithub } = await import('./create-branch-github.ts');

function expectOk(r: AdapterResult<void>): asserts r is { ok: true; data: void } {
  if (!('ok' in r) || !r.ok) {
    throw new Error(`expected ok result, got ${JSON.stringify(r)}`);
  }
}

function findCall(needle: string): string {
  return execCalls().find((c) => c.includes(needle) || unquote(c).includes(needle)) ?? '';
}

const VALID_SHA = 'a'.repeat(40);

beforeEach(() => {
  resetExecMock();
});

describe('createBranchGithub — subprocess boundary', () => {
  test('argv: gh api repos/<slug>/git/refs -X POST -f ref=refs/heads/<branch> -f sha=<sha>', async () => {
    onExec('gh api repos/org/repo/git/refs', '');

    const result = await createBranchGithub({
      branch: 'kahuna/42-wave-status-cli',
      sha: VALID_SHA,
      repo: 'org/repo',
    });
    expectOk(result);

    const call = findCall('gh api');
    expect(call).toContain('repos/org/repo/git/refs');
    expect(call).toContain('-X');
    expect(call).toContain('POST');
    expect(call).toContain('-f');
    // After shell-unquoting, the -f key=value pairs are present.
    const flat = unquote(call);
    expect(flat).toContain('ref=refs/heads/kahuna/42-wave-status-cli');
    expect(flat).toContain(`sha=${VALID_SHA}`);
  });

  test('void return on success', async () => {
    onExec('gh api', '');
    const result = await createBranchGithub({
      branch: 'feature/1-demo',
      sha: VALID_SHA,
      repo: 'org/repo',
    });
    expectOk(result);
    expect(result.data).toBeUndefined();
  });

  test('returns ok:false when gh exits non-zero', async () => {
    onExec('gh api', () => {
      const err = new Error('gh: Reference already exists') as ThrowableError;
      err.stderr = 'Reference already exists';
      err.status = 1;
      throw err;
    });

    const result = await createBranchGithub({
      branch: 'kahuna/1-foo',
      sha: VALID_SHA,
      repo: 'org/repo',
    });
    expect('ok' in result && result.ok).toBe(false);
    expect((result as { code: string }).code).toBe('gh_create_branch_failed');
    expect((result as { error: string }).error).toContain('kahuna/1-foo');
  });

  test('does NOT pass --repo flag (gh api is path-resolved)', async () => {
    onExec('gh api', '');
    await createBranchGithub({
      branch: 'kahuna/1-foo',
      sha: VALID_SHA,
      repo: 'org/repo',
    });
    const call = findCall('gh api');
    expect(call).not.toContain('--repo');
  });

  test('rejects invalid branch characters', async () => {
    const result = await createBranchGithub({
      branch: 'bad; rm -rf /',
      sha: VALID_SHA,
      repo: 'org/repo',
    });
    expect('ok' in result && result.ok).toBe(false);
    expect((result as { code: string }).code).toBe('invalid_branch');
    expect(execCalls().length).toBe(0);
  });

  test('rejects invalid sha', async () => {
    const result = await createBranchGithub({
      branch: 'main',
      sha: 'not-a-sha',
      repo: 'org/repo',
    });
    expect('ok' in result && result.ok).toBe(false);
    expect((result as { code: string }).code).toBe('invalid_sha');
    expect(execCalls().length).toBe(0);
  });

  test('rejects invalid repo slug', async () => {
    const result = await createBranchGithub({
      branch: 'main',
      sha: VALID_SHA,
      repo: 'no-slash',
    });
    expect('ok' in result && result.ok).toBe(false);
    expect((result as { code: string }).code).toBe('invalid_repo');
    expect(execCalls().length).toBe(0);
  });
});
