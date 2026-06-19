import { describe, test, expect, beforeEach } from 'bun:test';
import {
  installChildProcessMock,
  setExecMock,
  resetExecMock,
  execCalls,
} from '../test-support/mock-child-process.ts';
import type { AdapterResult, IssueClosureInfo } from './types.ts';

// Subprocess-boundary tests for the GitHub fetchIssueClosure adapter
// (Story 2.20, hybrid sub-call). Install own mock.module BEFORE the dynamic
// import (56-file convention).

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

const { fetchIssueClosureGithub, fetchIssueClosureGithubSync } = await import(
  './fetch-issue-closure-github.ts'
);

beforeEach(() => {
  resetExecMock();
  setExecMock(() => '');
});

describe('fetchIssueClosureGithubSync — subprocess boundary', () => {
  test('OPEN state returns {OPEN, closedByMergedPR: false}', () => {
    setExecMock(() =>
      JSON.stringify({
        data: {
          repository: {
            issue: {
              state: 'OPEN',
              closedByPullRequestsReferences: { nodes: [] },
              timelineItems: { nodes: [] },
            },
          },
        },
      }),
    );
    const info = fetchIssueClosureGithubSync(42, 'org/repo');
    expect(info.state).toBe('OPEN');
    expect(info.closedByMergedPR).toBe(false);
  });

  test('CLOSED with a merged PR reference is closedByMergedPR:true', () => {
    setExecMock(() =>
      JSON.stringify({
        data: {
          repository: {
            issue: {
              state: 'CLOSED',
              closedByPullRequestsReferences: {
                nodes: [{ merged: true }],
              },
              timelineItems: { nodes: [] },
            },
          },
        },
      }),
    );
    const info = fetchIssueClosureGithubSync(42, 'org/repo');
    expect(info.state).toBe('CLOSED');
    expect(info.closedByMergedPR).toBe(true);
  });

  test('CLOSED via timeline PullRequest closer is closedByMergedPR:true', () => {
    setExecMock(() =>
      JSON.stringify({
        data: {
          repository: {
            issue: {
              state: 'CLOSED',
              closedByPullRequestsReferences: { nodes: [] },
              timelineItems: {
                nodes: [{ closer: { __typename: 'PullRequest' } }],
              },
            },
          },
        },
      }),
    );
    const info = fetchIssueClosureGithubSync(42, 'org/repo');
    expect(info.state).toBe('CLOSED');
    expect(info.closedByMergedPR).toBe(true);
  });

  test('CLOSED with no linked PR and non-PR closer is closedByMergedPR:false', () => {
    setExecMock(() =>
      JSON.stringify({
        data: {
          repository: {
            issue: {
              state: 'CLOSED',
              closedByPullRequestsReferences: { nodes: [{ merged: false }] },
              timelineItems: { nodes: [{ closer: { __typename: 'User' } }] },
            },
          },
        },
      }),
    );
    const info = fetchIssueClosureGithubSync(42, 'org/repo');
    expect(info.state).toBe('CLOSED');
    expect(info.closedByMergedPR).toBe(false);
  });

  test('missing issue throws', () => {
    setExecMock(() => JSON.stringify({ data: { repository: { issue: null } } }));
    expect(() => fetchIssueClosureGithubSync(999, 'org/repo')).toThrow(
      /not found/,
    );
  });

  test('passes owner/repo/num as -F flags (no shell injection)', () => {
    setExecMock(() =>
      JSON.stringify({
        data: { repository: { issue: { state: 'OPEN' } } },
      }),
    );
    fetchIssueClosureGithubSync(7, 'acme-org/my.repo_42');
    expect(execCalls()[0]).toContain('-F owner=acme-org');
    expect(execCalls()[0]).toContain('-F repo=my.repo_42');
    expect(execCalls()[0]).toContain('-F num=7');
  });

  test('rejects malicious repo slug at adapter boundary (no exec)', () => {
    expect(() =>
      fetchIssueClosureGithubSync(42, 'org/repo; rm -rf /'),
    ).toThrow(/invalid repo slug/);
    expect(execCalls().length).toBe(0);
  });

  test('rejects missing slug (no exec)', () => {
    expect(() => fetchIssueClosureGithubSync(42, undefined)).toThrow(/required/);
    expect(execCalls().length).toBe(0);
  });
});

describe('fetchIssueClosureGithub — AdapterResult wrapper', () => {
  test('returns ok:true on success', async () => {
    setExecMock(() =>
      JSON.stringify({
        data: {
          repository: {
            issue: {
              state: 'CLOSED',
              closedByPullRequestsReferences: { nodes: [{ merged: true }] },
              timelineItems: { nodes: [] },
            },
          },
        },
      }),
    );
    const result = await fetchIssueClosureGithub({ number: 1, repo: 'org/repo' });
    expectOk(result);
    expect(result.data.state).toBe('CLOSED');
    expect(result.data.closedByMergedPR).toBe(true);
  });

  test('returns ok:false with code on subprocess failure', async () => {
    setExecMock(() => {
      throw new Error('gh: graphql 404');
    });
    const result = await fetchIssueClosureGithub({ number: 999, repo: 'org/repo' });
    expectErr(result);
    expect(result.code).toBe('gh_issue_closure_failed');
    expect(result.error).toContain('graphql 404');
  });

  test('returns ok:false on invalid repo slug (no exec)', async () => {
    const result = await fetchIssueClosureGithub({ number: 1, repo: 'bad slug' });
    expectErr(result);
    expect(result.error).toMatch(/invalid repo slug/);
    expect(execCalls().length).toBe(0);
  });
});
