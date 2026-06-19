import { describe, test, expect, beforeEach } from 'bun:test';
import {
  installChildProcessMock,
  setExecMock,
  resetExecMock,
  execCalls,
} from '../test-support/mock-child-process.ts';
import type { AdapterIssue, AdapterResult } from './types.ts';

// Subprocess-boundary tests for the GitLab fetchIssue adapter (Story 2.1,
// keystone hybrid sub-call). Each test file installs its OWN mock.module
// BEFORE the dynamic import (56-file convention).

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

installChildProcessMock();

const { fetchIssueGitlab, fetchIssueGitlabSync } = await import(
  './fetch-issue-gitlab.ts'
);

beforeEach(() => {
  resetExecMock();
  setExecMock(() => '');
});

describe('fetchIssueGitlab — argv shape via gitlabApiIssue helper', () => {
  test('invokes glab api projects/:id/issues/:iid with explicit owner/repo', () => {
    setExecMock(() =>
      JSON.stringify({
        iid: 42,
        title: 't',
        description: 'b',
        state: 'opened',
        labels: [],
        web_url: 'https://gitlab.com/foo/bar/-/issues/42',
      }),
    );
    fetchIssueGitlabSync(42, 'foo/bar');
    const apiCall = execCalls().find((c) => c.includes('glab api')) ?? '';
    expect(apiCall).toContain('projects/foo%2Fbar/issues/42');
  });

  test('falls back to cwd project slug when repo arg omitted', () => {
    setExecMock((cmd: string) => {
      if (cmd.includes('git remote get-url')) {
        return 'https://gitlab.com/org/repo.git\n';
      }
      return JSON.stringify({
        iid: 7,
        title: '',
        description: '',
        state: 'opened',
        labels: [],
        web_url: '',
      });
    });
    fetchIssueGitlabSync(7);
    const apiCall = execCalls().find((c) => c.includes('glab api')) ?? '';
    expect(apiCall).toContain('/issues/7');
  });
});

describe('fetchIssueGitlab — parses glab api response into normalized shape', () => {
  test('normalizes opened -> OPEN and surfaces all fields', () => {
    setExecMock(() =>
      JSON.stringify({
        iid: 11,
        title: 'demo',
        description: 'hello world',
        state: 'opened',
        labels: ['priority::high', 'size::S'],
        web_url: 'https://gitlab.com/org/repo/-/issues/11',
      }),
    );
    const issue = fetchIssueGitlabSync(11, 'org/repo');
    expect(issue.number).toBe(11);
    expect(issue.title).toBe('demo');
    expect(issue.state).toBe('OPEN');
    expect(issue.url).toBe('https://gitlab.com/org/repo/-/issues/11');
    expect(issue.body).toBe('hello world');
    expect(issue.labels).toEqual(['priority::high', 'size::S']);
  });

  test('normalizes closed -> CLOSED', () => {
    setExecMock(() =>
      JSON.stringify({
        iid: 11,
        title: 't',
        description: 'b',
        state: 'closed',
        labels: [],
        web_url: '',
      }),
    );
    expect(fetchIssueGitlabSync(11, 'org/repo').state).toBe('CLOSED');
  });

  test('coerces null description to empty body', () => {
    setExecMock(() =>
      JSON.stringify({
        iid: 11,
        title: 't',
        description: null,
        state: 'opened',
        labels: [],
        web_url: '',
      }),
    );
    expect(fetchIssueGitlabSync(11, 'org/repo').body).toBe('');
  });
});

describe('fetchIssueGitlab — AdapterResult wrapper', () => {
  test('returns ok:true wrapping AdapterIssue on success', async () => {
    setExecMock(() =>
      JSON.stringify({
        iid: 1,
        title: 't',
        description: 'b',
        state: 'opened',
        labels: ['bug'],
        web_url: 'https://gitlab.com/org/repo/-/issues/1',
      }),
    );
    const result = await fetchIssueGitlab({ number: 1, repo: 'org/repo' });
    expectOk(result);
    expect(result.data.number).toBe(1);
    expect(result.data.state).toBe('OPEN');
    expect(result.data.labels).toEqual(['bug']);
  });

  test('returns AdapterResult.error on glab failure', async () => {
    setExecMock(() => {
      throw new Error('glab: 404 not found');
    });
    const result = await fetchIssueGitlab({ number: 999, repo: 'org/repo' });
    expectErr(result);
    expect(result.code).toBe('glab_api_issue_failed');
    expect(result.error).toContain('not found');
  });
});
