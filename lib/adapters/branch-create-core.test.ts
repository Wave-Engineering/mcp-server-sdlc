import { describe, test, expect, beforeEach } from 'bun:test';
import {
  installChildProcessMock,
  onExec,
  resetExecMock,
  execCalls,
} from '../test-support/mock-child-process.ts';

// Subprocess-boundary tests for the platform-agnostic branch_create core (#579):
// name validation, dirty-tree refusal, and the checkout sequence.

installChildProcessMock();

const { branchCreateCore } = await import('./branch-create-core.ts');

function expectErr(r: ReturnType<typeof branchCreateCore>): asserts r is { ok: false; code: string; error: string } {
  if (r.ok) throw new Error(`expected error, got ${JSON.stringify(r)}`);
}

beforeEach(() => {
  resetExecMock();
});

function stubCleanCheckout(base: string, branch: string): void {
  onExec('git status --porcelain', '');
  onExec(`git checkout ${base}`, '');
  onExec(`git pull --ff-only origin ${base}`, '');
  onExec(`git checkout -b ${branch}`, '');
  onExec('git rev-parse HEAD', 'abc123def456abc123def456abc123def456abcd\n');
}

describe('branchCreateCore — name validation', () => {
  test('rejects a plural/unknown prefix before touching git', () => {
    const r = branchCreateCore({ branch: 'features/1-x', base: 'main', cwd: '/w' });
    expectErr(r);
    expect(r.code).toBe('invalid_branch_prefix');
    expect(execCalls().length).toBe(0);
  });

  test('rejects "docs/" (the canonical singular-prefix mistake)', () => {
    const r = branchCreateCore({ branch: 'docs/12-thing', base: 'main', cwd: '/w' });
    expectErr(r);
    expect(r.code).toBe('invalid_branch_prefix');
  });

  test('rejects a valid prefix with no issue number', () => {
    const r = branchCreateCore({ branch: 'chore/cleanup', base: 'main', cwd: '/w' });
    expectErr(r);
    expect(r.code).toBe('invalid_branch_name');
    expect(execCalls().length).toBe(0);
  });
});

describe('branchCreateCore — git flow', () => {
  test('happy path: clean tree → checkout/pull/checkout-b, returns issue number + base sha', () => {
    stubCleanCheckout('main', 'feature/579-branch-create-tool');
    const r = branchCreateCore({ branch: 'feature/579-branch-create-tool', base: 'main', cwd: '/w' });
    if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
    expect(r.data.issue_number).toBe(579);
    expect(r.data.base).toBe('main');
    expect(r.data.base_sha).toBe('abc123def456abc123def456abc123def456abcd');
    // The three git steps ran, in order.
    const flat = execCalls().map((c) => c.replace(/'/g, ''));
    expect(flat.some((c) => c.includes('git checkout main'))).toBe(true);
    expect(flat.some((c) => c.includes('git pull --ff-only origin main'))).toBe(true);
    expect(flat.some((c) => c.includes('git checkout -b feature/579-branch-create-tool'))).toBe(true);
  });

  test('refuses on a dirty working tree — no checkout attempted', () => {
    onExec('git status --porcelain', ' M lib/adapters/foo.ts\n');
    const r = branchCreateCore({ branch: 'fix/579-x', base: 'main', cwd: '/w' });
    expectErr(r);
    expect(r.code).toBe('dirty_working_tree');
    expect(execCalls().some((c) => c.includes('checkout'))).toBe(false);
  });

  test('surfaces branch_exists when checkout -b reports an existing branch', () => {
    onExec('git status --porcelain', '');
    onExec('git checkout main', '');
    onExec('git pull --ff-only origin main', '');
    onExec('git checkout -b fix/579-dup', () => {
      const err = new Error("fatal: a branch named 'fix/579-dup' already exists") as Error & {
        status?: number;
        stderr?: string;
      };
      err.status = 128;
      err.stderr = "fatal: a branch named 'fix/579-dup' already exists";
      throw err;
    });
    const r = branchCreateCore({ branch: 'fix/579-dup', base: 'main', cwd: '/w' });
    expectErr(r);
    expect(r.code).toBe('branch_exists');
  });

  test('surfaces git_checkout_base_failed when the base checkout fails', () => {
    onExec('git status --porcelain', '');
    onExec('git checkout nonexistent', () => {
      const err = new Error('error: pathspec') as Error & { status?: number; stderr?: string };
      err.status = 1;
      err.stderr = "error: pathspec 'nonexistent' did not match";
      throw err;
    });
    const r = branchCreateCore({ branch: 'fix/579-x', base: 'nonexistent', cwd: '/w' });
    expectErr(r);
    expect(r.code).toBe('git_checkout_base_failed');
  });
});
