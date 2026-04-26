import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { AdapterResult, PrMergeResponse } from './types.ts';

// Subprocess-boundary tests for the GitHub pr_merge adapter (R-15).
// Integration-level coverage (handler dispatch, error envelope, full
// 23-test regression suite) stays in tests/pr_merge.test.ts; this file
// owns the argv-shape and aggregate-envelope assertions that prove the
// adapter speaks `gh` correctly and preserves the #225 + #258 + #224
// behaviors across the lift.

interface ThrowableError extends Error {
  stderr?: string;
  stdout?: string;
  status?: number;
}

let execRegistry: Array<{ match: string; respond: string | (() => string) }> = [];
let execCalls: string[] = [];

function unquote(cmd: string): string {
  return cmd.replace(/'([^']*)'/g, '$1');
}

const mockExecSync = mock((cmd: string, _opts?: unknown) => {
  execCalls.push(cmd);
  const flat = unquote(cmd);
  for (const { match, respond } of execRegistry) {
    if (cmd.includes(match) || flat.includes(match)) {
      return typeof respond === 'function' ? respond() : respond;
    }
  }
  const err = new Error(`Unexpected exec: ${cmd}`) as ThrowableError;
  err.stderr = `Unexpected exec: ${cmd}`;
  err.status = 127;
  throw err;
});

mock.module('child_process', () => ({ execSync: mockExecSync }));

const { prMergeGithub } = await import('./pr-merge-github.ts');
const { clearMergeQueueCache } = await import('../merge_queue_detect.ts');

function on(match: string, respond: string | (() => string)): void {
  execRegistry.push({ match, respond });
}

// Default GraphQL stub for queue detection: respond "no queue" so the
// direct path / stderr-fallback tests don't need per-test boilerplate.
function stubNoQueue(): void {
  on(
    'gh api graphql',
    JSON.stringify({ data: { repository: { mergeQueue: null } } }),
  );
}

function stubEnforcedQueue(): void {
  on(
    'gh api graphql',
    JSON.stringify({
      data: { repository: { mergeQueue: { __typename: 'MergeQueue' } } },
    }),
  );
}

function mergeQueueError(): ThrowableError {
  const err = new Error(
    'failed to run git: merge strategy for main is set by the merge queue',
  ) as ThrowableError;
  err.stderr =
    'failed to run git: merge strategy for main is set by the merge queue\n';
  return err;
}

function expectOk(
  r: AdapterResult<PrMergeResponse>,
): asserts r is { ok: true; data: PrMergeResponse } {
  if (!('ok' in r) || !r.ok) {
    throw new Error(`expected ok result, got ${JSON.stringify(r)}`);
  }
}

function expectErr(
  r: AdapterResult<PrMergeResponse>,
): asserts r is { ok: false; error: string; code: string } {
  if (!('ok' in r) || r.ok) {
    throw new Error(`expected error result, got ${JSON.stringify(r)}`);
  }
}

function findCall(needle: string): string {
  return execCalls.find((c) => c.includes(needle) || unquote(c).includes(needle)) ?? '';
}

beforeEach(() => {
  execRegistry = [];
  execCalls = [];
  clearMergeQueueCache();
  // Default cwd remote — tests can override before relevant calls.
  on('git remote get-url origin', 'https://github.com/org/repo.git\n');
});

describe('prMergeGithub — subprocess boundary', () => {
  test('direct merge returns aggregate envelope (#225 shape preservation)', async () => {
    stubNoQueue();
    on('gh pr merge 42 --squash --delete-branch', '');
    on(
      'gh pr view 42 --json state,url,mergeCommit',
      JSON.stringify({
        state: 'MERGED',
        url: 'https://github.com/org/repo/pull/42',
        mergeCommit: { oid: 'abc123def456' },
      }),
    );

    const result = await prMergeGithub({ number: 42 });
    expectOk(result);
    expect(result.data).toEqual({
      number: 42,
      enrolled: true,
      merged: true,
      merge_method: 'direct_squash',
      queue: { enabled: false, position: null, enforced: false },
      pr_state: 'MERGED',
      url: 'https://github.com/org/repo/pull/42',
      merge_commit_sha: 'abc123def456',
      warnings: [],
    });
  });

  test('queue path returns enrolled+OPEN (#225 honesty preservation)', async () => {
    stubEnforcedQueue();
    on('gh pr merge 100 --squash --delete-branch --auto', '');
    on(
      'gh pr view 100 --json state,url,mergeCommit',
      JSON.stringify({
        state: 'OPEN',
        url: 'https://github.com/org/repo/pull/100',
        mergeCommit: null,
      }),
    );

    const result = await prMergeGithub({ number: 100 });
    expectOk(result);
    expect(result.data.merge_method).toBe('merge_queue');
    expect(result.data.enrolled).toBe(true);
    expect(result.data.merged).toBe(false);
    expect(result.data.pr_state).toBe('OPEN');
    expect(result.data.queue.enabled).toBe(true);
    expect(result.data.queue.enforced).toBe(true);
    // Critical: NO failed direct merge call before --auto.
    const directOnly = execCalls.find(
      (c) =>
        c.startsWith('gh pr merge 100 --squash --delete-branch') && !c.includes('--auto'),
    );
    expect(directOnly).toBeUndefined();
  });

  test('skip_train + enforced queue emits warning (#224 fold preservation)', async () => {
    stubEnforcedQueue();
    on('gh pr merge 200 --squash --delete-branch --auto', '');
    on(
      'gh pr view 200 --json state,url,mergeCommit',
      JSON.stringify({
        state: 'OPEN',
        url: 'https://github.com/org/repo/pull/200',
        mergeCommit: null,
      }),
    );

    const result = await prMergeGithub({ number: 200, skip_train: true });
    expectOk(result);
    expect(result.data.merge_method).toBe('merge_queue');
    expect(result.data.warnings).toBeArray();
    expect(result.data.warnings.length).toBe(1);
    expect(result.data.warnings[0]).toContain('skip_train ignored');
    expect(result.data.warnings[0]).toContain('merge queue');
  });

  test('use_merge_queue + skip_train precedence warning (#225 F3 preservation)', async () => {
    stubNoQueue();
    on('gh pr merge 250 --squash --delete-branch --auto', '');
    on(
      'gh pr view 250 --json state,url,mergeCommit',
      JSON.stringify({
        state: 'OPEN',
        url: 'https://github.com/org/repo/pull/250',
        mergeCommit: null,
      }),
    );

    const result = await prMergeGithub({
      number: 250,
      use_merge_queue: true,
      skip_train: true,
    });
    expectOk(result);
    expect(result.data.merge_method).toBe('merge_queue');
    expect(result.data.warnings.length).toBe(1);
    expect(result.data.warnings[0]).toContain('skip_train ignored');
    expect(result.data.warnings[0]).toContain('use_merge_queue');
  });

  test('returns AdapterResult{ok:false, code} on gh failure (not thrown)', async () => {
    stubNoQueue();
    on('gh pr merge 8 --squash --delete-branch', () => {
      const err = new Error('Pull request is not mergeable: conflicts') as ThrowableError;
      err.stderr = 'Pull request is not mergeable: conflicts\n';
      throw err;
    });

    const result = await prMergeGithub({ number: 8 });
    expectErr(result);
    expect(result.code).toBe('gh_pr_merge_failed');
    expect(result.error).toContain('gh pr merge failed');
  });

  test('stderr-fallback into queue: --auto retried after queue stderr', async () => {
    stubNoQueue(); // detection returns false-negative
    let directCalled = false;
    on('gh pr merge 55 --squash --delete-branch', () => {
      if (!directCalled) {
        directCalled = true;
        throw mergeQueueError();
      }
      return '';
    });
    on(
      'gh pr view 55 --json state,url,mergeCommit',
      JSON.stringify({
        state: 'OPEN',
        url: 'https://github.com/org/repo/pull/55',
        mergeCommit: null,
      }),
    );

    const result = await prMergeGithub({ number: 55 });
    expectOk(result);
    expect(result.data.merge_method).toBe('merge_queue');
    expect(result.data.queue).toEqual({ enabled: true, position: null, enforced: true });
    const autoCall = execCalls.find(
      (c) => c.includes('gh pr merge 55') && c.includes('--auto'),
    );
    expect(autoCall).toBeDefined();
  });

  test('regression #258: direct exec exit 0 + state OPEN reports merged:false, merge_queue', async () => {
    stubNoQueue();
    on('gh pr merge 99 --squash --delete-branch', ''); // exits 0
    on(
      'gh pr view 99 --json state,url,mergeCommit',
      JSON.stringify({
        state: 'OPEN', // gh enrolled but didn't merge synchronously
        url: 'https://github.com/org/repo/pull/99',
        mergeCommit: null,
      }),
    );

    const result = await prMergeGithub({ number: 99 });
    expectOk(result);
    expect(result.data.enrolled).toBe(true);
    expect(result.data.merged).toBe(false);
    expect(result.data.pr_state).toBe('OPEN');
    expect(result.data.merge_method).toBe('merge_queue');
    expect(result.data.merge_commit_sha).toBeUndefined();
  });

  test('multi-line squash message → --body-file', async () => {
    stubNoQueue();
    on('gh pr merge 21 --squash --delete-branch', '');
    on(
      'gh pr view 21 --json state,url,mergeCommit',
      JSON.stringify({
        state: 'MERGED',
        url: 'https://github.com/org/repo/pull/21',
        mergeCommit: { oid: 'aaaaaaaa' },
      }),
    );

    const body = 'feat: do the thing\n\nLong body\nwith multiple lines\n\nCloses #21\n';
    const result = await prMergeGithub({ number: 21, squash_message: body });
    expectOk(result);
    const mergeCall = findCall('gh pr merge 21');
    expect(mergeCall).toContain('--body-file');
    expect(mergeCall).not.toMatch(/--body\s+'feat:/);
  });

  test('--repo forwarded to merge + view + queue detection', async () => {
    on('git remote get-url origin', 'https://github.com/cwd-org/cwd-repo.git\n');
    stubNoQueue();
    on('gh pr merge 42 --squash --delete-branch', '');
    on(
      'gh pr view 42 --json state,url,mergeCommit',
      JSON.stringify({
        state: 'MERGED',
        url: 'https://github.com/Wave-Engineering/mcp-server-sdlc/pull/42',
        mergeCommit: { oid: 'abc123' },
      }),
    );

    const result = await prMergeGithub({
      number: 42,
      repo: 'Wave-Engineering/mcp-server-sdlc',
    });
    expectOk(result);
    const mergeCall = findCall('gh pr merge 42');
    expect(mergeCall).toContain('--repo Wave-Engineering/mcp-server-sdlc');
    const viewCall = findCall('gh pr view 42');
    expect(viewCall).toContain('--repo Wave-Engineering/mcp-server-sdlc');
    const graphqlCall = findCall('gh api graphql');
    expect(graphqlCall).toContain('-F owner=Wave-Engineering');
    expect(graphqlCall).toContain('-F name=mcp-server-sdlc');
  });
});
