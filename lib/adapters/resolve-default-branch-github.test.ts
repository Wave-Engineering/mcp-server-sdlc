import { describe, test, expect, beforeEach } from 'bun:test';
import {
  installChildProcessMock,
  onExec,
  resetExecMock,
  execCalls,
} from '../test-support/mock-child-process.ts';
import type { AdapterResult, ResolveDefaultBranchResponse } from './types.ts';

// Subprocess-boundary tests for the GitHub resolveDefaultBranch adapter (#465).

interface ThrowableError extends Error {
  stderr?: string;
  status?: number;
}

installChildProcessMock();

const { resolveDefaultBranchGithub, resolveDefaultBranchGithubSync } = await import(
  './resolve-default-branch-github.ts'
);

function expectOk(
  r: AdapterResult<ResolveDefaultBranchResponse>,
): asserts r is { ok: true; data: ResolveDefaultBranchResponse } {
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

beforeEach(() => {
  resetExecMock();
});

describe('resolveDefaultBranchGithub — subprocess boundary', () => {
  test('happy path — gh repo view --json defaultBranchRef → default branch', async () => {
    onExec('gh repo view', 'main\n');

    const r = await resolveDefaultBranchGithub({});
    expectOk(r);
    expect(r.data.default_branch).toBe('main');

    const call = findCall('gh repo view');
    expect(call).toContain('--json');
    expect(call).toContain('defaultBranchRef');
    expect(call).toContain('.defaultBranchRef.name');
  });

  test('passes an explicit slug through to gh repo view', async () => {
    onExec('gh repo view', 'develop\n');

    const r = await resolveDefaultBranchGithub({ repo: 'org/repo' });
    expectOk(r);
    expect(r.data.default_branch).toBe('develop');
    expect(findCall('gh repo view')).toContain('org/repo');
  });

  test('ok:false when gh repo view fails', async () => {
    onExec('gh repo view', () => {
      const e = new Error('auth') as ThrowableError;
      e.stderr = 'auth required';
      e.status = 1;
      throw e;
    });

    const r = await resolveDefaultBranchGithub({});
    expect('ok' in r && r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('default branch');
  });

  test('sync core throws on empty output', () => {
    onExec('gh repo view', '\n');
    expect(() => resolveDefaultBranchGithubSync(undefined, '/tmp')).toThrow(/default branch/);
  });
});
