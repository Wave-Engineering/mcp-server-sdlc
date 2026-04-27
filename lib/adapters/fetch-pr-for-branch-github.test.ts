import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { AdapterResult, PrForBranchRef } from './types.ts';

// Subprocess-boundary tests for the GitHub fetchPrForBranch adapter
// (Story 2.18, #312). Mirrors the 56-file convention: install own
// mock.module BEFORE the dynamic import.

function expectOk(
  r: AdapterResult<PrForBranchRef | null>,
): asserts r is { ok: true; data: PrForBranchRef | null } {
  if (!('ok' in r) || !r.ok) {
    throw new Error(`expected ok result, got ${JSON.stringify(r)}`);
  }
}

function expectErr(
  r: AdapterResult<PrForBranchRef | null>,
): asserts r is { ok: false; error: string; code: string } {
  if (!('ok' in r) || r.ok) {
    throw new Error(`expected error result, got ${JSON.stringify(r)}`);
  }
}

let execCalls: string[] = [];
let execMockFn: (cmd: string) => string = () => '';
const mockExecSync = mock((cmd: string) => {
  execCalls.push(cmd);
  return execMockFn(cmd);
});
mock.module('child_process', () => ({ execSync: mockExecSync }));

const { fetchPrForBranchGithub, fetchPrForBranchGithubSync } = await import(
  './fetch-pr-for-branch-github.ts'
);

beforeEach(() => {
  execCalls = [];
  execMockFn = () => '';
  mockExecSync.mockClear();
});

describe('fetch-pr-for-branch-github — argv + state filter', () => {
  test('passes --head, --state, --json fields in argv', () => {
    execMockFn = () =>
      JSON.stringify([
        { number: 7, url: 'https://github.com/org/repo/pull/7' },
      ]);
    fetchPrForBranchGithubSync('feature/42-thing', 'open');
    expect(execCalls.length).toBe(1);
    expect(execCalls[0]).toContain('gh pr list');
    expect(execCalls[0]).toContain('--head feature/42-thing');
    expect(execCalls[0]).toContain('--state open');
    expect(execCalls[0]).toContain('--json number,url');
  });

  test('passes caller state verbatim (merged)', () => {
    execMockFn = () => '[]';
    fetchPrForBranchGithubSync('feature/42-thing', 'merged');
    expect(execCalls[0]).toContain('--state merged');
  });

  test('passes caller state verbatim (all)', () => {
    execMockFn = () => '[]';
    fetchPrForBranchGithubSync('feature/42-thing', 'all');
    expect(execCalls[0]).toContain('--state all');
  });

  test('passes --repo when supplied', () => {
    execMockFn = () => '[]';
    fetchPrForBranchGithubSync('feature/42-thing', 'open', 'org/other');
    expect(execCalls[0]).toContain('--repo org/other');
  });

  test('omits --repo when not supplied (uses cwd)', () => {
    execMockFn = () => '[]';
    fetchPrForBranchGithubSync('feature/42-thing', 'open');
    expect(execCalls[0]).not.toContain('--repo');
  });

  test('returns first PR when list is non-empty', () => {
    execMockFn = () =>
      JSON.stringify([
        { number: 7, url: 'https://github.com/org/repo/pull/7' },
        { number: 8, url: 'https://github.com/org/repo/pull/8' },
      ]);
    const ref = fetchPrForBranchGithubSync('feature/42-thing', 'open');
    expect(ref).toEqual({ number: 7, url: 'https://github.com/org/repo/pull/7' });
  });

  test('rejects malicious repo slug at adapter boundary (no exec)', () => {
    expect(() =>
      fetchPrForBranchGithubSync('feature/42-x', 'open', 'org/repo; rm -rf /'),
    ).toThrow(/invalid repo slug/);
    expect(execCalls.length).toBe(0);
  });

  test('rejects branch with shell metacharacter (no exec)', () => {
    expect(() =>
      fetchPrForBranchGithubSync('feature/42-x`whoami`', 'open'),
    ).toThrow(/invalid branch/);
    expect(execCalls.length).toBe(0);
  });
});

describe('fetch-pr-for-branch-github — null when no matching PR', () => {
  test('returns null when empty array', () => {
    execMockFn = () => '[]';
    const ref = fetchPrForBranchGithubSync('feature/42-thing', 'open');
    expect(ref).toBeNull();
  });

  test('returns null when first entry missing url', () => {
    execMockFn = () => JSON.stringify([{ number: 7 }]);
    const ref = fetchPrForBranchGithubSync('feature/42-thing', 'open');
    expect(ref).toBeNull();
  });

  test('returns null when first entry missing number', () => {
    execMockFn = () =>
      JSON.stringify([{ url: 'https://github.com/org/repo/pull/7' }]);
    const ref = fetchPrForBranchGithubSync('feature/42-thing', 'open');
    expect(ref).toBeNull();
  });
});

describe('fetch-pr-for-branch-github — AdapterResult wrapper', () => {
  test('returns ok:true wrapping ref on success', async () => {
    execMockFn = () =>
      JSON.stringify([
        { number: 7, url: 'https://github.com/org/repo/pull/7' },
      ]);
    const result = await fetchPrForBranchGithub({
      branch: 'feature/42-x',
    });
    expectOk(result);
    expect(result.data).toEqual({
      number: 7,
      url: 'https://github.com/org/repo/pull/7',
    });
  });

  test('returns ok:true + data:null when no match', async () => {
    execMockFn = () => '[]';
    const result = await fetchPrForBranchGithub({
      branch: 'feature/42-x',
    });
    expectOk(result);
    expect(result.data).toBeNull();
  });

  test('defaults state to open when omitted', async () => {
    execMockFn = () => '[]';
    await fetchPrForBranchGithub({ branch: 'feature/42-x' });
    expect(execCalls[0]).toContain('--state open');
  });

  test('returns ok:false with code on subprocess failure', async () => {
    execMockFn = () => {
      throw new Error('gh: network error');
    };
    const result = await fetchPrForBranchGithub({
      branch: 'feature/42-x',
    });
    expectErr(result);
    expect(result.code).toBe('gh_pr_list_failed');
    expect(result.error).toContain('network error');
  });

  test('returns ok:false on invalid repo slug (no exec)', async () => {
    const result = await fetchPrForBranchGithub({
      branch: 'feature/42-x',
      repo: 'bad; rm',
    });
    expectErr(result);
    expect(result.error).toMatch(/invalid repo slug/);
    expect(execCalls.length).toBe(0);
  });
});
