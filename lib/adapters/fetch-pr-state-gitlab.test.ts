import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { AdapterResult, PrStateInfo } from './types.ts';

// Subprocess-boundary tests for the GitLab fetchPrState adapter (Story 1.11,
// hybrid sub-call). Each test file installs its OWN mock.module BEFORE the
// dynamic import (56-file convention).

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

const { fetchPrStateGitlab, fetchPrStateGitlabSync } = await import(
  './fetch-pr-state-gitlab.ts'
);

beforeEach(() => {
  execCalls = [];
  execMockFn = () => '';
  mockExecSync.mockClear();
});

describe('fetchPrStateGitlabSync — subprocess boundary', () => {
  test('parses merged state via glab api', () => {
    execMockFn = (cmd: string) => {
      if (cmd.includes('git remote get-url')) {
        return 'https://gitlab.com/org/repo.git\n';
      }
      return JSON.stringify({
        state: 'merged',
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/7',
        merge_commit_sha: 'cafebabe',
      });
    };
    const info = fetchPrStateGitlabSync(7);
    expect(info.state).toBe('merged');
    expect(info.url).toBe('https://gitlab.com/org/repo/-/merge_requests/7');
    expect(info.mergeCommitSha).toBe('cafebabe');
  });

  test('parses opened state', () => {
    execMockFn = (cmd: string) => {
      if (cmd.includes('git remote get-url')) {
        return 'https://gitlab.com/org/repo.git\n';
      }
      return JSON.stringify({
        state: 'opened',
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/7',
      });
    };
    const info = fetchPrStateGitlabSync(7);
    expect(info.state).toBe('open');
    expect(info.mergeCommitSha).toBeUndefined();
  });

  test('uses explicit owner/repo when provided', () => {
    execMockFn = () =>
      JSON.stringify({ state: 'opened', web_url: '' });
    fetchPrStateGitlabSync(11, 'foo/bar');
    const apiCall = execCalls.find((c) => c.includes('glab api')) ?? '';
    expect(apiCall).toContain('foo%2Fbar');
  });
});

describe('fetchPrStateGitlab — AdapterResult wrapper', () => {
  test('returns ok:true wrapping PrStateInfo on success', async () => {
    execMockFn = () =>
      JSON.stringify({
        state: 'merged',
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/1',
        merge_commit_sha: 'abc',
      });
    const result = await fetchPrStateGitlab({ number: 1, repo: 'org/repo' });
    expectOk(result);
    expect(result.data.state).toBe('merged');
    expect(result.data.mergeCommitSha).toBe('abc');
  });

  test('returns ok:false with code on subprocess failure', async () => {
    execMockFn = () => {
      throw new Error('glab: 404 not found');
    };
    const result = await fetchPrStateGitlab({ number: 999, repo: 'org/repo' });
    expectErr(result);
    expect(result.code).toBe('glab_api_mr_failed');
    expect(result.error).toContain('not found');
  });
});
