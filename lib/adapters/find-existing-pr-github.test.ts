import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { AdapterResult, NormalizedPr } from './types.ts';

// Subprocess-boundary tests for the GitHub findExistingPr adapter
// (Story 2.23, #317). Mirrors the 56-file convention: install own
// mock.module BEFORE the dynamic import.

function expectOk(
  r: AdapterResult<NormalizedPr | null>,
): asserts r is { ok: true; data: NormalizedPr | null } {
  if (!('ok' in r) || !r.ok) {
    throw new Error(`expected ok result, got ${JSON.stringify(r)}`);
  }
}

function expectErr(
  r: AdapterResult<NormalizedPr | null>,
): asserts r is { ok: false; error: string; code: string } {
  if (!('ok' in r) || r.ok) {
    throw new Error(`expected error result, got ${JSON.stringify(r)}`);
  }
}

let execCalls: string[] = [];
let execOpts: Array<{ cwd?: string } | undefined> = [];
let execMockFn: (cmd: string) => string = () => '';
const mockExecSync = mock((cmd: string, opts?: { cwd?: string }) => {
  execCalls.push(cmd);
  execOpts.push(opts);
  return execMockFn(cmd);
});
mock.module('child_process', () => ({ execSync: mockExecSync }));

const { findExistingPrGithub, findExistingPrGithubSync } = await import(
  './find-existing-pr-github.ts'
);

beforeEach(() => {
  execCalls = [];
  execOpts = [];
  execMockFn = () => '';
  mockExecSync.mockClear();
});

describe('find-existing-pr-github — argv', () => {
  test('passes --head, --base, --state, --json, --limit 1 in argv', () => {
    execMockFn = () =>
      JSON.stringify([
        {
          number: 7,
          url: 'https://github.com/o/r/pull/7',
          state: 'OPEN',
          headRefName: 'kahuna/42-foo',
          baseRefName: 'main',
          title: 't',
        },
      ]);
    findExistingPrGithubSync('kahuna/42-foo', 'main', 'open');
    expect(execCalls.length).toBe(1);
    expect(execCalls[0]).toContain('gh pr list');
    expect(execCalls[0]).toContain('--head kahuna/42-foo');
    expect(execCalls[0]).toContain('--base main');
    expect(execCalls[0]).toContain('--state open');
    expect(execCalls[0]).toContain('--json number,url,state,headRefName,baseRefName,title');
    expect(execCalls[0]).toContain('--limit 1');
  });

  test('passes caller state verbatim (merged)', () => {
    execMockFn = () => '[]';
    findExistingPrGithubSync('kahuna/42-foo', 'main', 'merged');
    expect(execCalls[0]).toContain('--state merged');
  });

  test('passes caller state verbatim (closed)', () => {
    execMockFn = () => '[]';
    findExistingPrGithubSync('kahuna/42-foo', 'main', 'closed');
    expect(execCalls[0]).toContain('--state closed');
  });

  test('passes --repo when supplied', () => {
    execMockFn = () => '[]';
    findExistingPrGithubSync('kahuna/42-foo', 'main', 'open', 'org/other');
    expect(execCalls[0]).toContain('--repo org/other');
  });

  test('omits --repo when not supplied (uses cwd)', () => {
    execMockFn = () => '[]';
    findExistingPrGithubSync('kahuna/42-foo', 'main', 'open');
    expect(execCalls[0]).not.toContain('--repo');
  });

  test('runs gh in args.cwd when supplied (#453)', () => {
    execMockFn = () => '[]';
    findExistingPrGithubSync('kahuna/42-foo', 'main', 'open', undefined, '/work/tree');
    expect(execOpts[0]?.cwd).toBe('/work/tree');
  });

  test('leaves cwd undefined when not supplied (env default unchanged)', () => {
    execMockFn = () => '[]';
    findExistingPrGithubSync('kahuna/42-foo', 'main', 'open');
    expect(execOpts[0]?.cwd).toBeUndefined();
  });

  test('async wrapper threads args.cwd through to gh', async () => {
    execMockFn = () => '[]';
    await findExistingPrGithub({
      head: 'kahuna/42-foo',
      base: 'main',
      state: 'open',
      cwd: '/work/tree',
    });
    expect(execOpts[0]?.cwd).toBe('/work/tree');
  });

  test('rejects malicious repo slug at adapter boundary (no exec)', () => {
    expect(() =>
      findExistingPrGithubSync('kahuna/42-foo', 'main', 'open', 'org/repo; rm -rf /'),
    ).toThrow(/invalid repo slug/);
    expect(execCalls.length).toBe(0);
  });

  test('rejects branch with shell metacharacter (no exec)', () => {
    expect(() =>
      findExistingPrGithubSync('kahuna/42-foo`whoami`', 'main', 'open'),
    ).toThrow(/invalid head/);
    expect(execCalls.length).toBe(0);
  });

  test('rejects base with shell metacharacter (no exec)', () => {
    expect(() =>
      findExistingPrGithubSync('kahuna/42-foo', 'main;rm', 'open'),
    ).toThrow(/invalid base/);
    expect(execCalls.length).toBe(0);
  });
});

describe('find-existing-pr-github — normalization', () => {
  test('returns NormalizedPr with lowercased state on non-empty list', () => {
    execMockFn = () =>
      JSON.stringify([
        {
          number: 88,
          url: 'https://github.com/o/r/pull/88',
          state: 'OPEN',
          headRefName: 'kahuna/42-foo',
          baseRefName: 'main',
          title: 'epic: foo',
        },
      ]);
    const pr = findExistingPrGithubSync('kahuna/42-foo', 'main', 'open');
    expect(pr).toEqual({
      number: 88,
      title: 'epic: foo',
      state: 'open',
      head: 'kahuna/42-foo',
      base: 'main',
      url: 'https://github.com/o/r/pull/88',
    });
  });

  test('returns null on empty list', () => {
    execMockFn = () => '[]';
    const pr = findExistingPrGithubSync('kahuna/42-foo', 'main', 'open');
    expect(pr).toBeNull();
  });

  test('returns null when first entry missing url', () => {
    execMockFn = () =>
      JSON.stringify([
        { number: 7, state: 'OPEN', headRefName: 'kahuna/42-foo', baseRefName: 'main' },
      ]);
    expect(findExistingPrGithubSync('kahuna/42-foo', 'main', 'open')).toBeNull();
  });

  test('returns null when first entry missing headRefName', () => {
    execMockFn = () =>
      JSON.stringify([
        { number: 7, url: 'https://github.com/o/r/pull/7', baseRefName: 'main' },
      ]);
    expect(findExistingPrGithubSync('kahuna/42-foo', 'main', 'open')).toBeNull();
  });
});

describe('find-existing-pr-github — AdapterResult wrapper', () => {
  test('returns ok:true wrapping pr on success', async () => {
    execMockFn = () =>
      JSON.stringify([
        {
          number: 7,
          url: 'https://github.com/o/r/pull/7',
          state: 'OPEN',
          headRefName: 'kahuna/42-foo',
          baseRefName: 'main',
          title: 't',
        },
      ]);
    const result = await findExistingPrGithub({
      head: 'kahuna/42-foo',
      base: 'main',
      state: 'open',
    });
    expectOk(result);
    expect(result.data?.number).toBe(7);
  });

  test('returns ok:true + data:null when no match', async () => {
    execMockFn = () => '[]';
    const result = await findExistingPrGithub({
      head: 'kahuna/42-foo',
      base: 'main',
      state: 'open',
    });
    expectOk(result);
    expect(result.data).toBeNull();
  });

  test('returns ok:false with code on subprocess failure', async () => {
    execMockFn = () => {
      throw new Error('gh: network error');
    };
    const result = await findExistingPrGithub({
      head: 'kahuna/42-foo',
      base: 'main',
      state: 'open',
    });
    expectErr(result);
    expect(result.code).toBe('gh_pr_list_failed');
    expect(result.error).toContain('network error');
  });

  test('returns ok:false on invalid repo slug (no exec)', async () => {
    const result = await findExistingPrGithub({
      head: 'kahuna/42-foo',
      base: 'main',
      state: 'open',
      repo: 'bad; rm',
    });
    expectErr(result);
    expect(result.error).toMatch(/invalid repo slug/);
    expect(execCalls.length).toBe(0);
  });
});
