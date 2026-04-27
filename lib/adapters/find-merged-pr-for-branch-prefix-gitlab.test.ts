import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { AdapterResult } from './types.ts';

// Subprocess-boundary tests for the GitLab findMergedPrForBranchPrefix adapter
// (Story 2.21, #315). Each test file installs its OWN mock.module BEFORE the
// dynamic import (56-file convention).

type Payload = { url: string } | null;

interface ThrowableError extends Error {
  stderr?: string;
  stdout?: string;
  status?: number;
}

let execRegistry: Array<{ match: string; respond: string | (() => string) }> = [];
let execCalls: string[] = [];

const mockExecSync = mock((cmd: string, _opts?: unknown) => {
  execCalls.push(cmd);
  for (const { match, respond } of execRegistry) {
    if (cmd.includes(match)) {
      return typeof respond === 'function' ? respond() : respond;
    }
  }
  const err = new Error(`Unexpected exec: ${cmd}`) as ThrowableError;
  err.stderr = `Unexpected exec: ${cmd}`;
  err.status = 127;
  throw err;
});

mock.module('child_process', () => ({ execSync: mockExecSync }));

const {
  findMergedPrForBranchPrefixGitlab,
  findMergedPrForBranchPrefixGitlabSync,
  DEFAULT_LIMIT,
} = await import('./find-merged-pr-for-branch-prefix-gitlab.ts');

function on(match: string, respond: string | (() => string)): void {
  execRegistry.push({ match, respond });
}

function findCall(needle: string): string {
  return execCalls.find((c) => c.includes(needle)) ?? '';
}

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

beforeEach(() => {
  execRegistry = [];
  execCalls = [];
});

describe('find-merged-pr-for-branch-prefix-gitlab — argv + prefix match', () => {
  test('passes state=merged + per_page=<limit> query params', () => {
    on('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    on('glab api projects/org%2Frepo/merge_requests', JSON.stringify([]));
    findMergedPrForBranchPrefixGitlabSync('feature/42-', 100);
    const call = findCall('glab api projects/');
    expect(call).toContain('state=merged');
    expect(call).toContain('per_page=100');
  });

  test('default limit is 100 (widens bug #282 hardcoded 50)', async () => {
    on('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    on('glab api projects/org%2Frepo/merge_requests', JSON.stringify([]));
    expect(DEFAULT_LIMIT).toBe(100);
    await findMergedPrForBranchPrefixGitlab({ prefix: 'feature/42-' });
    const call = findCall('glab api projects/');
    expect(call).toContain('per_page=100');
    expect(call).not.toContain('per_page=50');
  });

  test('caller limit honored verbatim (e.g. 250)', async () => {
    on('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    on('glab api projects/org%2Frepo/merge_requests', JSON.stringify([]));
    await findMergedPrForBranchPrefixGitlab({ prefix: 'feature/42-', limit: 250 });
    const call = findCall('glab api projects/');
    expect(call).toContain('per_page=250');
  });

  test('args.repo overrides cwd slug (URL-encoded)', () => {
    on(
      'glab api projects/target-org%2Ftarget-repo/merge_requests',
      JSON.stringify([]),
    );
    findMergedPrForBranchPrefixGitlabSync('feature/42-', 100, 'target-org/target-repo');
    const call = findCall('glab api projects/');
    expect(call).toContain('target-org%2Ftarget-repo');
  });

  test('returns first MR whose source_branch startsWith prefix', () => {
    on('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    on(
      'glab api projects/org%2Frepo/merge_requests',
      JSON.stringify([
        {
          iid: 5, state: 'merged', source_branch: 'other/5-thing', target_branch: 'main',
          web_url: 'https://gitlab.com/org/repo/-/merge_requests/5', labels: [], title: 't',
        },
        {
          iid: 7, state: 'merged', source_branch: 'feature/42-foo', target_branch: 'main',
          web_url: 'https://gitlab.com/org/repo/-/merge_requests/7', labels: [], title: 't',
        },
        {
          iid: 8, state: 'merged', source_branch: 'feature/42-bar', target_branch: 'main',
          web_url: 'https://gitlab.com/org/repo/-/merge_requests/8', labels: [], title: 't',
        },
      ]),
    );
    const result = findMergedPrForBranchPrefixGitlabSync('feature/42-', 100);
    expect(result).toEqual({ url: 'https://gitlab.com/org/repo/-/merge_requests/7' });
  });

  test('rejects non-integer limit (no exec)', () => {
    expect(() => findMergedPrForBranchPrefixGitlabSync('feature/42-', 0)).toThrow(/invalid limit/);
    expect(() => findMergedPrForBranchPrefixGitlabSync('feature/42-', -5)).toThrow(/invalid limit/);
    expect(() => findMergedPrForBranchPrefixGitlabSync('feature/42-', 1.5)).toThrow(/invalid limit/);
  });
});

describe('find-merged-pr-for-branch-prefix-gitlab — null when no matching MR', () => {
  test('returns null when empty array', () => {
    on('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    on('glab api projects/org%2Frepo/merge_requests', JSON.stringify([]));
    const result = findMergedPrForBranchPrefixGitlabSync('feature/42-', 100);
    expect(result).toBeNull();
  });

  test('returns null when no branch startsWith prefix', () => {
    on('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    on(
      'glab api projects/org%2Frepo/merge_requests',
      JSON.stringify([
        {
          iid: 5, state: 'merged', source_branch: 'other/5-thing', target_branch: 'main',
          web_url: 'https://gitlab.com/org/repo/-/merge_requests/5', labels: [], title: 't',
        },
      ]),
    );
    const result = findMergedPrForBranchPrefixGitlabSync('feature/42-', 100);
    expect(result).toBeNull();
  });
});

describe('find-merged-pr-for-branch-prefix-gitlab — AdapterResult wrapper', () => {
  test('returns ok:true wrapping url on success', async () => {
    on('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    on(
      'glab api projects/org%2Frepo/merge_requests',
      JSON.stringify([
        {
          iid: 7, state: 'merged', source_branch: 'feature/42-foo', target_branch: 'main',
          web_url: 'https://gitlab.com/org/repo/-/merge_requests/7', labels: [], title: 't',
        },
      ]),
    );
    const result = await findMergedPrForBranchPrefixGitlab({ prefix: 'feature/42-' });
    expectOk(result);
    expect(result.data).toEqual({ url: 'https://gitlab.com/org/repo/-/merge_requests/7' });
  });

  test('returns ok:true + data:null when no match', async () => {
    on('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    on('glab api projects/org%2Frepo/merge_requests', JSON.stringify([]));
    const result = await findMergedPrForBranchPrefixGitlab({ prefix: 'feature/42-' });
    expectOk(result);
    expect(result.data).toBeNull();
  });

  test('returns ok:false with code on subprocess failure', async () => {
    on('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    on('glab api projects/org%2Frepo/merge_requests', () => {
      const err = new Error('glab: not authenticated') as ThrowableError;
      err.stderr = 'glab: not authenticated';
      err.status = 1;
      throw err;
    });
    const result = await findMergedPrForBranchPrefixGitlab({ prefix: 'feature/42-' });
    expectErr(result);
    expect(result.code).toBe('glab_api_mr_list_failed');
    expect(result.error).toContain('glab');
  });
});
