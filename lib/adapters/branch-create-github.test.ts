import { describe, test, expect, beforeEach } from 'bun:test';
import {
  installChildProcessMock,
  onExec,
  resetExecMock,
  execCalls,
} from '../test-support/mock-child-process.ts';
import type { AdapterResult, BranchCreateResponse } from './types.ts';

// Subprocess-boundary tests for the GitHub branch_create adapter (#579):
// default-base resolution, the self-assign wiring, and error passthrough.

installChildProcessMock();

const { branchCreateGithub } = await import('./branch-create-github.ts');

function expectOk(
  r: AdapterResult<BranchCreateResponse>,
): asserts r is { ok: true; data: BranchCreateResponse } {
  if (!('ok' in r) || !r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
}
function expectErr(
  r: AdapterResult<BranchCreateResponse>,
): asserts r is { ok: false; code: string; error: string } {
  if (!('ok' in r) || r.ok) throw new Error(`expected error, got ${JSON.stringify(r)}`);
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

describe('branchCreateGithub', () => {
  test('happy path (base given): creates branch and self-assigns the linked issue', async () => {
    stubCleanCheckout('main', 'feature/579-foo');
    onExec('gh issue edit 579', 'ok\n');

    const r = await branchCreateGithub({ branch: 'feature/579-foo', base: 'main', cwd: '/w' });
    expectOk(r);
    expect(r.data.issue_number).toBe(579);
    expect(r.data.issue_assigned).toBe(579);
    expect(r.data.warnings).toBeUndefined();
    const edit = execCalls().find((c) => c.includes("'gh' 'issue' 'edit' '579'")) ?? '';
    expect(edit).toContain("'--add-assignee' '@me'");
  });

  test('resolves the default branch when base is omitted', async () => {
    onExec('gh repo view', 'main\n'); // resolveDefaultBranchGithubSync
    stubCleanCheckout('main', 'fix/579-bar');
    onExec('gh issue edit 579', 'ok\n');

    const r = await branchCreateGithub({ branch: 'fix/579-bar', cwd: '/w' });
    expectOk(r);
    expect(r.data.base).toBe('main');
  });

  test('self-assign failure is non-fatal — branch still created, warning surfaced', async () => {
    stubCleanCheckout('main', 'fix/579-baz');
    onExec('gh issue edit 579', () => {
      const err = new Error('gh: not found') as Error & { status?: number; stderr?: string };
      err.status = 1;
      err.stderr = 'gh: not found';
      throw err;
    });

    const r = await branchCreateGithub({ branch: 'fix/579-baz', base: 'main', cwd: '/w' });
    expectOk(r);
    expect(r.data.issue_assigned).toBeUndefined();
    expect(r.data.warnings?.length).toBe(1);
    expect(r.data.warnings?.[0]).toContain('#579');
  });

  test('passes through core validation errors (dirty tree)', async () => {
    onExec('git status --porcelain', ' M x\n');
    const r = await branchCreateGithub({ branch: 'fix/579-x', base: 'main', cwd: '/w' });
    expectErr(r);
    expect(r.code).toBe('dirty_working_tree');
  });

  test('passes through core validation errors (bad prefix)', async () => {
    const r = await branchCreateGithub({ branch: 'features/1-x', base: 'main', cwd: '/w' });
    expectErr(r);
    expect(r.code).toBe('invalid_branch_prefix');
  });
});
