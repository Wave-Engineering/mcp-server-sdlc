import { describe, test, expect, beforeEach } from 'bun:test';
import {
  installChildProcessMock,
  setExecMock,
  resetExecMock,
  execCalls,
} from '../test-support/mock-child-process.ts';
import type { AdapterResult, IssueClosureInfo } from './types.ts';

// Subprocess-boundary tests for the GitLab fetchIssueClosure adapter
// (Story 2.20, hybrid sub-call). Each test file installs its OWN mock.module
// BEFORE the dynamic import (56-file convention).

function expectOk(
  r: AdapterResult<IssueClosureInfo>,
): asserts r is { ok: true; data: IssueClosureInfo } {
  if (!('ok' in r) || !r.ok) {
    throw new Error(`expected ok result, got ${JSON.stringify(r)}`);
  }
}

function expectErr(
  r: AdapterResult<IssueClosureInfo>,
): asserts r is { ok: false; error: string; code: string } {
  if (!('ok' in r) || r.ok) {
    throw new Error(`expected error result, got ${JSON.stringify(r)}`);
  }
}

installChildProcessMock();

const { fetchIssueClosureGitlab, fetchIssueClosureGitlabSync } = await import(
  './fetch-issue-closure-gitlab.ts'
);

beforeEach(() => {
  resetExecMock();
  setExecMock(() => '');
});

describe('fetchIssueClosureGitlabSync — state-only semantics', () => {
  test('opened -> {OPEN, closedByMergedPR:false}', () => {
    setExecMock(() =>
      JSON.stringify({
        iid: 11,
        state: 'opened',
        title: 't',
        description: '',
        labels: [],
        web_url: '',
      }),
    );
    const info = fetchIssueClosureGitlabSync(11, 'org/repo');
    expect(info.state).toBe('OPEN');
    expect(info.closedByMergedPR).toBe(false);
  });

  test('closed -> {CLOSED, closedByMergedPR:true} (state-only)', () => {
    setExecMock(() =>
      JSON.stringify({
        iid: 11,
        state: 'closed',
        title: 't',
        description: '',
        labels: [],
        web_url: '',
      }),
    );
    const info = fetchIssueClosureGitlabSync(11, 'org/repo');
    expect(info.state).toBe('CLOSED');
    expect(info.closedByMergedPR).toBe(true);
  });

  test('invokes glab api projects/:id/issues/:iid with explicit owner/repo', () => {
    setExecMock(() =>
      JSON.stringify({
        iid: 42,
        state: 'opened',
        title: '',
        description: '',
        labels: [],
        web_url: '',
      }),
    );
    fetchIssueClosureGitlabSync(42, 'foo/bar');
    const apiCall = execCalls().find((c) => c.includes('glab api')) ?? '';
    expect(apiCall).toContain('projects/foo%2Fbar/issues/42');
  });
});

describe('fetchIssueClosureGitlab — AdapterResult wrapper', () => {
  test('returns ok:true on success', async () => {
    setExecMock(() =>
      JSON.stringify({
        iid: 1,
        state: 'closed',
        title: '',
        description: '',
        labels: [],
        web_url: '',
      }),
    );
    const result = await fetchIssueClosureGitlab({ number: 1, repo: 'org/repo' });
    expectOk(result);
    expect(result.data.state).toBe('CLOSED');
    expect(result.data.closedByMergedPR).toBe(true);
  });

  test('returns ok:false on glab failure', async () => {
    setExecMock(() => {
      throw new Error('glab: 404 not found');
    });
    const result = await fetchIssueClosureGitlab({ number: 999, repo: 'org/repo' });
    expectErr(result);
    expect(result.code).toBe('glab_issue_closure_failed');
    expect(result.error).toContain('not found');
  });
});
