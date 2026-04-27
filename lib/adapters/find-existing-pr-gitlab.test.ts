import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { AdapterResult, NormalizedPr } from './types.ts';

// Subprocess-boundary tests for the GitLab findExistingPr adapter
// (Story 2.23, #317). Each test file installs its OWN mock.module BEFORE
// the dynamic import (56-file convention).

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

const { findExistingPrGitlab, findExistingPrGitlabSync } = await import(
  './find-existing-pr-gitlab.ts'
);

function on(match: string, respond: string | (() => string)): void {
  execRegistry.push({ match, respond });
}

function findCall(needle: string): string {
  return execCalls.find((c) => c.includes(needle)) ?? '';
}

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

beforeEach(() => {
  execRegistry = [];
  execCalls = [];
});

describe('find-existing-pr-gitlab — argv + state translation', () => {
  test('passes source_branch, target_branch, state=opened, per_page=1', () => {
    on('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    on(
      'glab api projects/org%2Frepo/merge_requests',
      JSON.stringify([
        {
          iid: 7,
          state: 'opened',
          source_branch: 'kahuna/42-foo',
          target_branch: 'main',
          web_url: 'https://gitlab.com/org/repo/-/merge_requests/7',
          labels: [],
          title: 't',
          description: null,
        },
      ]),
    );
    findExistingPrGitlabSync('kahuna/42-foo', 'main', 'open');
    const call = findCall('glab api projects/');
    expect(call).toContain('source_branch=kahuna%2F42-foo');
    expect(call).toContain('target_branch=main');
    expect(call).toContain('state=opened');
    expect(call).toContain('per_page=1');
  });

  test('state=merged translates to state=merged query', () => {
    on('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    on('glab api projects/org%2Frepo/merge_requests', JSON.stringify([]));
    findExistingPrGitlabSync('kahuna/42-foo', 'main', 'merged');
    const call = findCall('glab api projects/');
    expect(call).toContain('state=merged');
  });

  test('state=closed translates to state=closed query', () => {
    on('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    on('glab api projects/org%2Frepo/merge_requests', JSON.stringify([]));
    findExistingPrGitlabSync('kahuna/42-foo', 'main', 'closed');
    const call = findCall('glab api projects/');
    expect(call).toContain('state=closed');
  });

  test('args.repo overrides cwd slug (URL-encoded)', () => {
    on(
      'glab api projects/target-org%2Ftarget-repo/merge_requests',
      JSON.stringify([]),
    );
    findExistingPrGitlabSync('kahuna/42-foo', 'main', 'open', 'target-org/target-repo');
    const call = findCall('glab api projects/');
    expect(call).toContain('target-org%2Ftarget-repo');
  });
});

describe('find-existing-pr-gitlab — normalization', () => {
  test('returns NormalizedPr with raw platform state on non-empty list', () => {
    on('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    on(
      'glab api projects/org%2Frepo/merge_requests',
      JSON.stringify([
        {
          iid: 88,
          state: 'opened',
          source_branch: 'kahuna/42-foo',
          target_branch: 'main',
          web_url: 'https://gitlab.com/org/repo/-/merge_requests/88',
          labels: [],
          title: 'epic: foo',
          description: null,
        },
      ]),
    );
    const pr = findExistingPrGitlabSync('kahuna/42-foo', 'main', 'open');
    expect(pr).toEqual({
      number: 88,
      title: 'epic: foo',
      state: 'opened',
      head: 'kahuna/42-foo',
      base: 'main',
      url: 'https://gitlab.com/org/repo/-/merge_requests/88',
    });
  });

  test('returns null on empty list', () => {
    on('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    on('glab api projects/org%2Frepo/merge_requests', JSON.stringify([]));
    expect(findExistingPrGitlabSync('kahuna/42-foo', 'main', 'open')).toBeNull();
  });
});

describe('find-existing-pr-gitlab — AdapterResult wrapper', () => {
  test('returns ok:true wrapping pr on success', async () => {
    on('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    on(
      'glab api projects/org%2Frepo/merge_requests',
      JSON.stringify([
        {
          iid: 7,
          state: 'opened',
          source_branch: 'kahuna/42-foo',
          target_branch: 'main',
          web_url: 'https://gitlab.com/org/repo/-/merge_requests/7',
          labels: [],
          title: 't',
          description: null,
        },
      ]),
    );
    const result = await findExistingPrGitlab({
      head: 'kahuna/42-foo',
      base: 'main',
      state: 'open',
    });
    expectOk(result);
    expect(result.data?.number).toBe(7);
  });

  test('returns ok:true + data:null when no match', async () => {
    on('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    on('glab api projects/org%2Frepo/merge_requests', JSON.stringify([]));
    const result = await findExistingPrGitlab({
      head: 'kahuna/42-foo',
      base: 'main',
      state: 'open',
    });
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
    const result = await findExistingPrGitlab({
      head: 'kahuna/42-foo',
      base: 'main',
      state: 'open',
    });
    expectErr(result);
    expect(result.code).toBe('glab_api_mr_list_failed');
    expect(result.error).toContain('glab');
  });
});
