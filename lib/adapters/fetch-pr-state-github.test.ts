import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { AdapterResult, PrStateInfo } from './types.ts';

// Subprocess-boundary tests for the GitHub fetchPrState adapter (Story 1.11,
// hybrid sub-call). Mirrors the pattern used by every adapter test file:
// install own mock.module BEFORE the dynamic import (56-file convention).

function expectOk(
  r: AdapterResult<PrStateInfo>,
): asserts r is { ok: true; data: PrStateInfo } {
  if (!('ok' in r) || !r.ok) {
    throw new Error(`expected ok result, got ${JSON.stringify(r)}`);
  }
}

function expectErr(
  r: AdapterResult<PrStateInfo>,
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

const { fetchPrStateGithub, fetchPrStateGithubSync } = await import(
  './fetch-pr-state-github.ts'
);

beforeEach(() => {
  execCalls = [];
  execMockFn = () => '';
  mockExecSync.mockClear();
});

describe('fetchPrStateGithubSync — subprocess boundary', () => {
  test('parses MERGED state with merge commit sha', () => {
    execMockFn = () =>
      JSON.stringify({
        state: 'MERGED',
        url: 'https://github.com/org/repo/pull/42',
        mergeCommit: { oid: 'deadbeef' },
      });
    const info = fetchPrStateGithubSync(42);
    expect(info.state).toBe('merged');
    expect(info.url).toBe('https://github.com/org/repo/pull/42');
    expect(info.mergeCommitSha).toBe('deadbeef');
  });

  test('parses OPEN state with no merge commit', () => {
    execMockFn = () =>
      JSON.stringify({
        state: 'OPEN',
        url: 'https://github.com/org/repo/pull/42',
        mergeCommit: null,
      });
    const info = fetchPrStateGithubSync(42);
    expect(info.state).toBe('open');
    expect(info.mergeCommitSha).toBeUndefined();
  });

  test('parses CLOSED state', () => {
    execMockFn = () =>
      JSON.stringify({
        state: 'CLOSED',
        url: 'https://github.com/org/repo/pull/42',
        mergeCommit: null,
      });
    const info = fetchPrStateGithubSync(42);
    expect(info.state).toBe('closed');
  });

  test('passes --repo when supplied', () => {
    execMockFn = () =>
      JSON.stringify({ state: 'OPEN', url: '', mergeCommit: null });
    fetchPrStateGithubSync(42, 'org/other-repo');
    expect(execCalls[0]).toContain('--repo org/other-repo');
  });

  test('omits --repo when not supplied (uses cwd)', () => {
    execMockFn = () =>
      JSON.stringify({ state: 'OPEN', url: '', mergeCommit: null });
    fetchPrStateGithubSync(42);
    expect(execCalls[0]).not.toContain('--repo');
  });

  test('unknown state defaults to open', () => {
    execMockFn = () =>
      JSON.stringify({ state: 'WEIRD', url: '', mergeCommit: null });
    expect(fetchPrStateGithubSync(42).state).toBe('open');
  });

  test('rejects malicious repo slug at adapter boundary (no exec)', () => {
    expect(() => fetchPrStateGithubSync(42, 'org/repo; rm -rf /')).toThrow(
      /invalid repo slug/,
    );
    expect(execCalls.length).toBe(0);
  });

  test('rejects repo slug with shell metacharacter (no exec)', () => {
    expect(() => fetchPrStateGithubSync(42, 'org/repo`whoami`')).toThrow(
      /invalid repo slug/,
    );
    expect(execCalls.length).toBe(0);
  });

  test('rejects repo with no slash (no exec)', () => {
    expect(() => fetchPrStateGithubSync(42, 'just-a-name')).toThrow(/invalid repo slug/);
    expect(execCalls.length).toBe(0);
  });
});

describe('fetchPrStateGithub — AdapterResult wrapper', () => {
  test('returns ok:true wrapping PrStateInfo on success', async () => {
    execMockFn = () =>
      JSON.stringify({
        state: 'MERGED',
        url: 'https://github.com/org/repo/pull/1',
        mergeCommit: { oid: 'abc' },
      });
    const result = await fetchPrStateGithub({ number: 1 });
    expectOk(result);
    expect(result.data.state).toBe('merged');
    expect(result.data.mergeCommitSha).toBe('abc');
  });

  test('returns ok:false with code on subprocess failure', async () => {
    execMockFn = () => {
      throw new Error('gh: PR not found');
    };
    const result = await fetchPrStateGithub({ number: 999 });
    expectErr(result);
    expect(result.code).toBe('gh_pr_view_failed');
    expect(result.error).toContain('PR not found');
  });

  test('returns ok:false on invalid repo slug (no exec)', async () => {
    const result = await fetchPrStateGithub({ number: 1, repo: 'bad; rm' });
    expectErr(result);
    expect(result.error).toMatch(/invalid repo slug/);
    expect(execCalls.length).toBe(0);
  });
});
