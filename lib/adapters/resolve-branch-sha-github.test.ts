import { describe, test, expect, beforeEach } from 'bun:test';
import {
  installChildProcessMock,
  onExec,
  resetExecMock,
  execCalls,
} from '../test-support/mock-child-process.ts';
import type {
  AdapterResult,
  ResolveBranchShaResponse,
} from './types.ts';

// Subprocess-boundary tests for the GitHub resolveBranchSha adapter (R-15).

interface ThrowableError extends Error {
  stderr?: string;
  stdout?: string;
  status?: number;
}

function unquote(cmd: string): string {
  return cmd.replace(/'([^']*)'/g, '$1');
}

installChildProcessMock();

const { resolveBranchShaGithub } = await import(
  './resolve-branch-sha-github.ts'
);

function expectOk(
  r: AdapterResult<ResolveBranchShaResponse | null>,
): asserts r is { ok: true; data: ResolveBranchShaResponse | null } {
  if (!('ok' in r) || !r.ok) {
    throw new Error(`expected ok result, got ${JSON.stringify(r)}`);
  }
}

function findCall(needle: string): string {
  return execCalls().find((c) => c.includes(needle) || unquote(c).includes(needle)) ?? '';
}

beforeEach(() => {
  resetExecMock();
});

describe('resolveBranchShaGithub — subprocess boundary', () => {
  test('argv: gh api repos/<slug>/git/refs/heads/<branch> --jq .object.sha', async () => {
    const sha = 'a'.repeat(40);
    onExec('gh api repos/org/repo/git/refs/heads/main', sha);

    const result = await resolveBranchShaGithub({ branch: 'main', repo: 'org/repo' });
    expectOk(result);
    expect(result.data).toEqual({ sha });

    const call = findCall('gh api');
    expect(call).toContain('repos/org/repo/git/refs/heads/main');
    expect(call).toContain('--jq');
    expect(call).toContain('.object.sha');
  });

  test('soft-fails to null when gh errors (preserves pre-migration contract)', async () => {
    onExec('gh api', () => {
      const err = new Error('gh: 404') as ThrowableError;
      err.stderr = 'gh: not found';
      err.status = 1;
      throw err;
    });

    const result = await resolveBranchShaGithub({ branch: 'main', repo: 'org/repo' });
    expectOk(result);
    expect(result.data).toBeNull();
  });

  test('returns null when stdout is not a valid 40-char SHA', async () => {
    onExec('gh api', 'not-a-sha');

    const result = await resolveBranchShaGithub({ branch: 'main', repo: 'org/repo' });
    expectOk(result);
    expect(result.data).toBeNull();
  });

  test('returns null when repo is omitted (no slug to target)', async () => {
    const result = await resolveBranchShaGithub({ branch: 'main' });
    expectOk(result);
    expect(result.data).toBeNull();
    // Must not have shelled out at all.
    expect(execCalls().length).toBe(0);
  });

  test('rejects invalid branch characters', async () => {
    const result = await resolveBranchShaGithub({
      branch: 'bad; rm -rf /',
      repo: 'org/repo',
    });
    expect('ok' in result && result.ok).toBe(false);
    expect((result as { code: string }).code).toBe('invalid_branch');
  });

  test('rejects invalid repo slug', async () => {
    const result = await resolveBranchShaGithub({
      branch: 'main',
      repo: 'no-slash',
    });
    expect('ok' in result && result.ok).toBe(false);
    expect((result as { code: string }).code).toBe('invalid_repo');
  });

  test('passes branch names with slashes (feature/1-demo) unharmed', async () => {
    const sha = 'b'.repeat(40);
    onExec('gh api repos/org/repo/git/refs/heads/feature/1-demo', sha);

    const result = await resolveBranchShaGithub({
      branch: 'feature/1-demo',
      repo: 'org/repo',
    });
    expectOk(result);
    expect(result.data).toEqual({ sha });
  });
});
