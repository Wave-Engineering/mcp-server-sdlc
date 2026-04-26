import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { AdapterIssue, AdapterResult } from './types.ts';

// Subprocess-boundary tests for the GitHub fetchIssue adapter (Story 2.1,
// keystone hybrid sub-call). Mirrors the pattern used by every adapter test
// file: install own mock.module BEFORE the dynamic import (56-file convention).

function expectOk(
  r: AdapterResult<AdapterIssue>,
): asserts r is { ok: true; data: AdapterIssue } {
  if (!('ok' in r) || !r.ok) {
    throw new Error(`expected ok result, got ${JSON.stringify(r)}`);
  }
}

function expectErr(
  r: AdapterResult<AdapterIssue>,
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

const { fetchIssueGithub, fetchIssueGithubSync } = await import(
  './fetch-issue-github.ts'
);

beforeEach(() => {
  execCalls = [];
  execMockFn = () => '';
  mockExecSync.mockClear();
});

describe('fetchIssueGithub — argv shape: gh issue view --json ... <number>', () => {
  test('invokes gh issue view with the required --json fields and number', () => {
    execMockFn = () =>
      JSON.stringify({
        number: 42,
        title: 't',
        state: 'OPEN',
        url: 'https://github.com/org/repo/issues/42',
        body: 'b',
        labels: [],
      });
    fetchIssueGithubSync(42);
    expect(execCalls.length).toBe(1);
    expect(execCalls[0]).toContain('gh issue view 42');
    expect(execCalls[0]).toContain(
      '--json number,title,state,url,body,labels',
    );
  });

  test('passes --repo when supplied', () => {
    execMockFn = () =>
      JSON.stringify({
        number: 1,
        title: '',
        state: 'OPEN',
        url: '',
        body: '',
        labels: [],
      });
    fetchIssueGithubSync(1, 'org/other-repo');
    expect(execCalls[0]).toContain('--repo org/other-repo');
  });

  test('omits --repo when not supplied (uses cwd)', () => {
    execMockFn = () =>
      JSON.stringify({
        number: 1,
        title: '',
        state: 'OPEN',
        url: '',
        body: '',
        labels: [],
      });
    fetchIssueGithubSync(1);
    expect(execCalls[0]).not.toContain('--repo');
  });

  test('rejects malicious repo slug at adapter boundary (no exec)', () => {
    expect(() => fetchIssueGithubSync(1, 'org/repo; rm -rf /')).toThrow(
      /invalid repo slug/,
    );
    expect(execCalls.length).toBe(0);
  });
});

describe('fetchIssueGithub — normalizes state + labels array', () => {
  test('parses OPEN state and extracts label names', () => {
    execMockFn = () =>
      JSON.stringify({
        number: 7,
        title: 'demo',
        state: 'OPEN',
        url: 'https://github.com/org/repo/issues/7',
        body: 'hello',
        labels: [
          { name: 'priority::high' },
          { name: 'size::S' },
        ],
      });
    const issue = fetchIssueGithubSync(7);
    expect(issue.number).toBe(7);
    expect(issue.title).toBe('demo');
    expect(issue.state).toBe('OPEN');
    expect(issue.url).toBe('https://github.com/org/repo/issues/7');
    expect(issue.body).toBe('hello');
    expect(issue.labels).toEqual(['priority::high', 'size::S']);
  });

  test('parses CLOSED state', () => {
    execMockFn = () =>
      JSON.stringify({
        number: 7,
        title: 't',
        state: 'CLOSED',
        url: '',
        body: '',
        labels: [],
      });
    expect(fetchIssueGithubSync(7).state).toBe('CLOSED');
  });

  test('unknown state defaults to OPEN', () => {
    execMockFn = () =>
      JSON.stringify({
        number: 7,
        title: 't',
        state: 'WEIRD',
        url: '',
        body: '',
        labels: [],
      });
    expect(fetchIssueGithubSync(7).state).toBe('OPEN');
  });

  test('missing labels yields empty array', () => {
    execMockFn = () =>
      JSON.stringify({
        number: 7,
        title: 't',
        state: 'OPEN',
        url: '',
        body: '',
      });
    expect(fetchIssueGithubSync(7).labels).toEqual([]);
  });

  test('filters out malformed label entries (non-string name)', () => {
    execMockFn = () =>
      JSON.stringify({
        number: 7,
        title: 't',
        state: 'OPEN',
        url: '',
        body: '',
        labels: [{ name: 'real' }, { notName: 'x' }, null, { name: '' }],
      });
    expect(fetchIssueGithubSync(7).labels).toEqual(['real']);
  });
});

describe('fetchIssueGithub — AdapterResult wrapper', () => {
  test('returns ok:true wrapping AdapterIssue on success', async () => {
    execMockFn = () =>
      JSON.stringify({
        number: 1,
        title: 't',
        state: 'OPEN',
        url: 'https://github.com/org/repo/issues/1',
        body: 'b',
        labels: [{ name: 'bug' }],
      });
    const result = await fetchIssueGithub({ number: 1 });
    expectOk(result);
    expect(result.data.number).toBe(1);
    expect(result.data.state).toBe('OPEN');
    expect(result.data.labels).toEqual(['bug']);
  });

  test('returns AdapterResult.error on gh failure', async () => {
    execMockFn = () => {
      throw new Error('gh: issue not found');
    };
    const result = await fetchIssueGithub({ number: 999 });
    expectErr(result);
    expect(result.code).toBe('gh_issue_view_failed');
    expect(result.error).toContain('not found');
  });

  test('returns ok:false on invalid repo slug (no exec)', async () => {
    const result = await fetchIssueGithub({ number: 1, repo: 'bad; rm' });
    expectErr(result);
    expect(result.error).toMatch(/invalid repo slug/);
    expect(execCalls.length).toBe(0);
  });
});
