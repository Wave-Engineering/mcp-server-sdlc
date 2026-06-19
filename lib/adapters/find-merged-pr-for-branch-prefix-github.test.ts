import { describe, test, expect, beforeEach } from 'bun:test';
import {
  installChildProcessMock,
  setExecMock,
  resetExecMock,
  execCalls,
} from '../test-support/mock-child-process.ts';
import type { AdapterResult } from './types.ts';

// Subprocess-boundary tests for the GitHub findMergedPrForBranchPrefix adapter
// (Story 2.21, #315). Mirrors the 56-file convention: install own
// mock.module BEFORE the dynamic import.

type Payload = { url: string } | null;

function expectOk(
  r: AdapterResult<Payload>,
): asserts r is { ok: true; data: Payload } {
  if (!('ok' in r) || !r.ok) {
    throw new Error(`expected ok result, got ${JSON.stringify(r)}`);
  }
}

function expectErr(
  r: AdapterResult<Payload>,
): asserts r is { ok: false; error: string; code: string } {
  if (!('ok' in r) || r.ok) {
    throw new Error(`expected error result, got ${JSON.stringify(r)}`);
  }
}

installChildProcessMock();

const {
  findMergedPrForBranchPrefixGithub,
  findMergedPrForBranchPrefixGithubSync,
  DEFAULT_LIMIT,
} = await import('./find-merged-pr-for-branch-prefix-github.ts');

beforeEach(() => {
  resetExecMock();
  setExecMock(() => '');
});

describe('find-merged-pr-for-branch-prefix-github — argv + prefix match', () => {
  test('passes --state merged, --json number,url,headRefName, --limit in argv', () => {
    setExecMock(() => '[]');
    findMergedPrForBranchPrefixGithubSync('feature/42-', 100);
    expect(execCalls().length).toBe(1);
    expect(execCalls()[0]).toContain('gh pr list');
    expect(execCalls()[0]).toContain('--state merged');
    expect(execCalls()[0]).toContain('--json number,url,headRefName');
    expect(execCalls()[0]).toContain('--limit 100');
  });

  test('default limit is 100 (widens bug #282 hardcoded 50)', async () => {
    setExecMock(() => '[]');
    expect(DEFAULT_LIMIT).toBe(100);
    await findMergedPrForBranchPrefixGithub({ prefix: 'feature/42-' });
    expect(execCalls()[0]).toContain('--limit 100');
    expect(execCalls()[0]).not.toContain('--limit 50');
  });

  test('caller limit honored verbatim (e.g. 250)', async () => {
    setExecMock(() => '[]');
    await findMergedPrForBranchPrefixGithub({ prefix: 'feature/42-', limit: 250 });
    expect(execCalls()[0]).toContain('--limit 250');
  });

  test('passes --repo when supplied', () => {
    setExecMock(() => '[]');
    findMergedPrForBranchPrefixGithubSync('feature/42-', 100, 'org/other');
    expect(execCalls()[0]).toContain('--repo org/other');
  });

  test('omits --repo when not supplied (uses cwd)', () => {
    setExecMock(() => '[]');
    findMergedPrForBranchPrefixGithubSync('feature/42-', 100);
    expect(execCalls()[0]).not.toContain('--repo');
  });

  test('returns first PR whose headRefName startsWith prefix', () => {
    setExecMock(() =>
      JSON.stringify([
        { number: 5, url: 'https://github.com/org/repo/pull/5', headRefName: 'other/5-thing' },
        { number: 7, url: 'https://github.com/org/repo/pull/7', headRefName: 'feature/42-foo' },
        { number: 8, url: 'https://github.com/org/repo/pull/8', headRefName: 'feature/42-bar' },
      ]),
    );
    const result = findMergedPrForBranchPrefixGithubSync('feature/42-', 100);
    expect(result).toEqual({ url: 'https://github.com/org/repo/pull/7' });
  });

  test('rejects malicious repo slug at adapter boundary (no exec)', () => {
    expect(() =>
      findMergedPrForBranchPrefixGithubSync('feature/42-', 100, 'org/repo; rm -rf /'),
    ).toThrow(/invalid repo slug/);
    expect(execCalls().length).toBe(0);
  });

  test('rejects prefix with shell metacharacter (no exec)', () => {
    expect(() =>
      findMergedPrForBranchPrefixGithubSync('feature/42-x`whoami`', 100),
    ).toThrow(/invalid prefix/);
    expect(execCalls().length).toBe(0);
  });

  test('rejects non-integer limit (no exec)', () => {
    expect(() => findMergedPrForBranchPrefixGithubSync('feature/42-', 0)).toThrow(/invalid limit/);
    expect(() => findMergedPrForBranchPrefixGithubSync('feature/42-', -5)).toThrow(/invalid limit/);
    expect(() => findMergedPrForBranchPrefixGithubSync('feature/42-', 1.5)).toThrow(/invalid limit/);
    expect(execCalls().length).toBe(0);
  });
});

describe('find-merged-pr-for-branch-prefix-github — null when no matching PR', () => {
  test('returns null when empty array', () => {
    setExecMock(() => '[]');
    const result = findMergedPrForBranchPrefixGithubSync('feature/42-', 100);
    expect(result).toBeNull();
  });

  test('returns null when no branch startsWith prefix', () => {
    setExecMock(() =>
      JSON.stringify([
        { number: 5, url: 'https://github.com/org/repo/pull/5', headRefName: 'other/5-thing' },
        { number: 7, url: 'https://github.com/org/repo/pull/7', headRefName: 'hotfix/99-thing' },
      ]),
    );
    const result = findMergedPrForBranchPrefixGithubSync('feature/42-', 100);
    expect(result).toBeNull();
  });

  test('returns null when matching PR has no url', () => {
    setExecMock(() =>
      JSON.stringify([
        { number: 7, headRefName: 'feature/42-foo' },
      ]),
    );
    const result = findMergedPrForBranchPrefixGithubSync('feature/42-', 100);
    expect(result).toBeNull();
  });
});

describe('find-merged-pr-for-branch-prefix-github — AdapterResult wrapper', () => {
  test('returns ok:true wrapping url on success', async () => {
    setExecMock(() =>
      JSON.stringify([
        { number: 7, url: 'https://github.com/org/repo/pull/7', headRefName: 'feature/42-foo' },
      ]),
    );
    const result = await findMergedPrForBranchPrefixGithub({ prefix: 'feature/42-' });
    expectOk(result);
    expect(result.data).toEqual({ url: 'https://github.com/org/repo/pull/7' });
  });

  test('returns ok:true + data:null when no match', async () => {
    setExecMock(() => '[]');
    const result = await findMergedPrForBranchPrefixGithub({ prefix: 'feature/42-' });
    expectOk(result);
    expect(result.data).toBeNull();
  });

  test('returns ok:false with code on subprocess failure', async () => {
    setExecMock(() => {
      throw new Error('gh: network error');
    });
    const result = await findMergedPrForBranchPrefixGithub({ prefix: 'feature/42-' });
    expectErr(result);
    expect(result.code).toBe('gh_pr_list_failed');
    expect(result.error).toContain('network error');
  });

  test('returns ok:false on invalid repo slug (no exec)', async () => {
    const result = await findMergedPrForBranchPrefixGithub({
      prefix: 'feature/42-',
      repo: 'bad; rm',
    });
    expectErr(result);
    expect(result.error).toMatch(/invalid repo slug/);
    expect(execCalls().length).toBe(0);
  });
});
