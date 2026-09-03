import { describe, test, expect, beforeEach } from 'bun:test';
import {
  installChildProcessMock,
  onExec,
  resetExecMock,
  execCalls,
} from '../test-support/mock-child-process.ts';
import type { AdapterResult, BranchCreateResponse } from './types.ts';

// Subprocess-boundary tests for the GitLab branch_create adapter (#579):
// self-assign via the additive `+user` form, and non-fatal null-resolution.
// The native Status flip is deferred to #580 (no status_transition here).

installChildProcessMock();

const { branchCreateGitlab } = await import('./branch-create-gitlab.ts');

function expectOk(
  r: AdapterResult<BranchCreateResponse>,
): asserts r is { ok: true; data: BranchCreateResponse } {
  if (!('ok' in r) || !r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
}

function stubCleanCheckout(base: string, branch: string): void {
  onExec('git status --porcelain', '');
  onExec(`git checkout ${base}`, '');
  onExec(`git pull --ff-only origin ${base}`, '');
  onExec(`git checkout -b ${branch}`, '');
  onExec('git rev-parse HEAD', 'abc123def456abc123def456abc123def456abcd\n');
}

beforeEach(() => {
  resetExecMock();
});

describe('branchCreateGitlab', () => {
  test('happy path: creates branch and additively self-assigns via +<user>', async () => {
    stubCleanCheckout('main', 'feature/579-foo');
    onExec('glab api /user', JSON.stringify({ username: 'bj-bots' }));
    onExec('glab issue update 579', 'ok\n');

    const r = await branchCreateGitlab({ branch: 'feature/579-foo', base: 'main', cwd: '/w' });
    expectOk(r);
    expect(r.data.issue_number).toBe(579);
    expect(r.data.issue_assigned).toBe(579);
    const upd = execCalls().find((c) => c.includes("'glab' 'issue' 'update' '579'")) ?? '';
    expect(upd).toContain("'--assignee' '+bj-bots'");
  });

  test('null self-resolution is non-fatal — branch created, warning, no assign', async () => {
    stubCleanCheckout('main', 'fix/579-bar');
    // No `glab api /user` stub → resolveGitlabSelfSync returns null.
    const r = await branchCreateGitlab({ branch: 'fix/579-bar', base: 'main', cwd: '/w' });
    expectOk(r);
    expect(r.data.issue_assigned).toBeUndefined();
    expect(r.data.warnings?.length).toBe(1);
    expect(execCalls().some((c) => c.includes("'glab' 'issue' 'update'"))).toBe(false);
  });

  test('status_transition is not set yet (deferred to #580)', async () => {
    stubCleanCheckout('main', 'feature/579-foo');
    onExec('glab api /user', JSON.stringify({ username: 'bj-bots' }));
    onExec('glab issue update 579', 'ok\n');

    const r = await branchCreateGitlab({ branch: 'feature/579-foo', base: 'main', cwd: '/w' });
    expectOk(r);
    expect(r.data.status_transition).toBeUndefined();
  });
});
