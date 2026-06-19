import { describe, test, expect, beforeEach } from 'bun:test';
import type { AdapterResult, PrForBranchRef } from './types.ts';
import {
  installChildProcessMock,
  onExec as on,
  resetExecMock,
  execCalls,
} from '../test-support/mock-child-process.ts';

// Subprocess-boundary tests for the GitLab fetchPrForBranch adapter
// (Story 2.18, #312). Each test file installs its OWN mock.module BEFORE
// the dynamic import (56-file convention).

interface ThrowableError extends Error {
  stderr?: string;
  stdout?: string;
  status?: number;
}

installChildProcessMock();

const { fetchPrForBranchGitlab, fetchPrForBranchGitlabSync } = await import(
  './fetch-pr-for-branch-gitlab.ts'
);

function findCall(needle: string): string {
  return execCalls().find((c) => c.includes(needle)) ?? '';
}

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

beforeEach(() => {
  resetExecMock();
});

describe('fetch-pr-for-branch-gitlab — argv + state filter', () => {
  test('passes source_branch + state=opened query params', () => {
    on('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    on(
      'glab api projects/org%2Frepo/merge_requests',
      JSON.stringify([
        {
          iid: 7,
          state: 'opened',
          source_branch: 'feature/42-thing',
          target_branch: 'main',
          web_url: 'https://gitlab.com/org/repo/-/merge_requests/7',
          labels: [],
          title: 't',
        },
      ]),
    );
    fetchPrForBranchGitlabSync('feature/42-thing', 'open');
    const call = findCall('glab api projects/');
    expect(call).toContain('source_branch=feature%2F42-thing');
    expect(call).toContain('state=opened');
  });

  test('state=merged translates to state=merged query', () => {
    on('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    on('glab api projects/org%2Frepo/merge_requests', JSON.stringify([]));
    fetchPrForBranchGitlabSync('feature/42-thing', 'merged');
    const call = findCall('glab api projects/');
    expect(call).toContain('state=merged');
  });

  test('state=all omits state query param entirely', () => {
    on('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    on('glab api projects/org%2Frepo/merge_requests', JSON.stringify([]));
    fetchPrForBranchGitlabSync('feature/42-thing', 'all');
    const call = findCall('glab api projects/');
    expect(call).not.toContain('state=');
  });

  test('args.repo overrides cwd slug (URL-encoded)', () => {
    on(
      'glab api projects/target-org%2Ftarget-repo/merge_requests',
      JSON.stringify([]),
    );
    fetchPrForBranchGitlabSync('feature/42-thing', 'open', 'target-org/target-repo');
    const call = findCall('glab api projects/');
    expect(call).toContain('target-org%2Ftarget-repo');
  });

  test('returns first MR when list is non-empty', () => {
    on('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    on(
      'glab api projects/org%2Frepo/merge_requests',
      JSON.stringify([
        {
          iid: 7,
          state: 'opened',
          source_branch: 'feature/42-thing',
          target_branch: 'main',
          web_url: 'https://gitlab.com/org/repo/-/merge_requests/7',
          labels: [],
          title: 't',
        },
        {
          iid: 8,
          state: 'opened',
          source_branch: 'feature/42-thing',
          target_branch: 'main',
          web_url: 'https://gitlab.com/org/repo/-/merge_requests/8',
          labels: [],
          title: 't2',
        },
      ]),
    );
    const ref = fetchPrForBranchGitlabSync('feature/42-thing', 'open');
    expect(ref).toEqual({
      number: 7,
      url: 'https://gitlab.com/org/repo/-/merge_requests/7',
    });
  });
});

describe('fetch-pr-for-branch-gitlab — null when no matching MR', () => {
  test('returns null when empty array', () => {
    on('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    on('glab api projects/org%2Frepo/merge_requests', JSON.stringify([]));
    const ref = fetchPrForBranchGitlabSync('feature/42-thing', 'open');
    expect(ref).toBeNull();
  });

  test('returns null when first entry missing iid', () => {
    on('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    on(
      'glab api projects/org%2Frepo/merge_requests',
      JSON.stringify([
        {
          web_url: 'https://gitlab.com/org/repo/-/merge_requests/7',
        },
      ]),
    );
    const ref = fetchPrForBranchGitlabSync('feature/42-thing', 'open');
    expect(ref).toBeNull();
  });
});

describe('fetch-pr-for-branch-gitlab — AdapterResult wrapper', () => {
  test('returns ok:true wrapping ref on success', async () => {
    on('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    on(
      'glab api projects/org%2Frepo/merge_requests',
      JSON.stringify([
        {
          iid: 7,
          state: 'opened',
          source_branch: 'feature/42-thing',
          target_branch: 'main',
          web_url: 'https://gitlab.com/org/repo/-/merge_requests/7',
          labels: [],
          title: 't',
        },
      ]),
    );
    const result = await fetchPrForBranchGitlab({
      branch: 'feature/42-thing',
    });
    expectOk(result);
    expect(result.data).toEqual({
      number: 7,
      url: 'https://gitlab.com/org/repo/-/merge_requests/7',
    });
  });

  test('returns ok:true + data:null when no match', async () => {
    on('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    on('glab api projects/org%2Frepo/merge_requests', JSON.stringify([]));
    const result = await fetchPrForBranchGitlab({
      branch: 'feature/42-thing',
    });
    expectOk(result);
    expect(result.data).toBeNull();
  });

  test('defaults state to open when omitted', async () => {
    on('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    on('glab api projects/org%2Frepo/merge_requests', JSON.stringify([]));
    await fetchPrForBranchGitlab({ branch: 'feature/42-thing' });
    const call = findCall('glab api projects/');
    expect(call).toContain('state=opened');
  });

  test('returns ok:false with code on subprocess failure', async () => {
    on('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    on('glab api projects/org%2Frepo/merge_requests', () => {
      const err = new Error('glab: not authenticated') as ThrowableError;
      err.stderr = 'glab: not authenticated';
      err.status = 1;
      throw err;
    });
    const result = await fetchPrForBranchGitlab({
      branch: 'feature/42-thing',
    });
    expectErr(result);
    expect(result.code).toBe('glab_api_mr_list_failed');
    expect(result.error).toContain('glab');
  });

  test('returns ok:true + data:null when glab returns empty output (#428)', async () => {
    on('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    on('glab api projects/org%2Frepo/merge_requests', () => {
      throw new Error(
        'glab returned empty output for: glab api projects/org%2Frepo/merge_requests?state=opened&source_branch=chore%2F4-thing&per_page=1',
      );
    });
    const result = await fetchPrForBranchGitlab({
      branch: 'chore/4-thing',
    });
    expectOk(result);
    expect(result.data).toBeNull();
  });
});
