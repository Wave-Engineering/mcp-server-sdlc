import { describe, test, expect, beforeEach } from 'bun:test';
import {
  installChildProcessMock,
  onExec,
  resetExecMock,
  execCalls,
} from '../test-support/mock-child-process.ts';
import type { AdapterResult, ResolveDefaultBranchResponse } from './types.ts';

// Subprocess-boundary tests for the GitLab resolveDefaultBranch adapter (#465).

installChildProcessMock();

const { resolveDefaultBranchGitlab, resolveDefaultBranchGitlabSync } = await import(
  './resolve-default-branch-gitlab.ts'
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

describe('resolveDefaultBranchGitlab — subprocess boundary', () => {
  test('happy path — glab api projects/:id → default_branch (no --jq)', async () => {
    onExec('glab api', JSON.stringify({ id: 1, default_branch: 'main' }));

    const r = await resolveDefaultBranchGitlab({});
    expectOk(r);
    expect(r.data.default_branch).toBe('main');

    const call = findCall('glab api');
    expect(call).toContain('projects/:id');
    // glab 1.36.0 rejects --jq; the adapter parses JSON in-process.
    expect(call).not.toContain('--jq');
  });

  test('URL-encodes an explicit slug into the projects path', async () => {
    onExec('glab api', JSON.stringify({ default_branch: 'develop' }));

    const r = await resolveDefaultBranchGitlab({ repo: 'org/repo' });
    expectOk(r);
    expect(r.data.default_branch).toBe('develop');
    expect(findCall('glab api')).toContain('projects/org%2Frepo');
  });

  test('ok:false when default_branch missing from the response', async () => {
    onExec('glab api', JSON.stringify({ id: 1 }));

    const r = await resolveDefaultBranchGitlab({});
    expect('ok' in r && r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('default_branch');
  });

  test('sync core throws when glab returns empty output', () => {
    onExec('glab api', '\n');
    expect(() => resolveDefaultBranchGitlabSync(undefined, '/tmp')).toThrow(/default branch/);
  });
});
