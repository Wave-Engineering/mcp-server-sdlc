import { describe, test, expect, beforeEach } from 'bun:test';
import {
  installChildProcessMock,
  onExec,
  resetExecMock,
  execCalls,
} from '../test-support/mock-child-process.ts';
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

function unquote(cmd: string): string {
  return cmd.replace(/'([^']*)'/g, '$1');
}

installChildProcessMock();

const { prMergeGithub } = await import('./pr-merge-github.ts');
const { clearMergeQueueCache } = await import('../merge_queue_detect.ts');

// Default GraphQL stub for queue detection: respond "no queue" so the
// direct path / stderr-fallback tests don't need per-test boilerplate.
function stubNoQueue(): void {
  onExec(
    'gh api graphql',
    JSON.stringify({ data: { repository: { mergeQueue: null } } }),
  );
}

function stubEnforcedQueue(): void {
  onExec(
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
  return execCalls().find((c) => c.includes(needle) || unquote(c).includes(needle)) ?? '';
}

beforeEach(() => {
  resetExecMock();
  clearMergeQueueCache();
  // Default cwd remote — tests can override before relevant calls.
  onExec('git remote get-url origin', 'https://github.com/org/repo.git\n');
});

describe('prMergeGithub — subprocess boundary', () => {
  test('direct merge returns aggregate envelope (#225 shape preservation)', async () => {
    stubNoQueue();
    onExec('gh pr merge 42 --squash --delete-branch', '');
    onExec(
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
      queue_fallback: false,
      graphql_fallback: false,
    });
  });

  test('queue path returns enrolled+OPEN (#225 honesty preservation)', async () => {
    stubEnforcedQueue();
    onExec('gh pr merge 100 --squash --delete-branch --auto', '');
    onExec(
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
    const directOnly = execCalls().find(
      (c) =>
        c.startsWith('gh pr merge 100 --squash --delete-branch') && !c.includes('--auto'),
    );
    expect(directOnly).toBeUndefined();
  });

  test('skip_train + enforced queue emits warning (#224 fold preservation)', async () => {
    stubEnforcedQueue();
    onExec('gh pr merge 200 --squash --delete-branch --auto', '');
    onExec(
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
    onExec('gh pr merge 250 --squash --delete-branch --auto', '');
    onExec(
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
    onExec('gh pr merge 8 --squash --delete-branch', () => {
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
    onExec('gh pr merge 55 --squash --delete-branch', () => {
      if (!directCalled) {
        directCalled = true;
        throw mergeQueueError();
      }
      return '';
    });
    onExec(
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
    const autoCall = execCalls().find(
      (c) => c.includes('gh pr merge 55') && c.includes('--auto'),
    );
    expect(autoCall).toBeDefined();
  });

  test('regression #258: direct exec exit 0 + state OPEN reports merged:false, merge_queue', async () => {
    stubNoQueue();
    onExec('gh pr merge 99 --squash --delete-branch', ''); // exits 0
    onExec(
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
    onExec('gh pr merge 21 --squash --delete-branch', '');
    onExec(
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
    onExec('git remote get-url origin', 'https://github.com/cwd-org/cwd-repo.git\n');
    stubNoQueue();
    onExec('gh pr merge 42 --squash --delete-branch', '');
    onExec(
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
    expect(unquote(mergeCall!)).toContain('--repo Wave-Engineering/mcp-server-sdlc');
    const viewCall = findCall('gh pr view 42');
    expect(unquote(viewCall!)).toContain('--repo Wave-Engineering/mcp-server-sdlc');
    const graphqlCall = findCall('gh api graphql');
    expect(graphqlCall).toContain('-F owner=Wave-Engineering');
    expect(graphqlCall).toContain('-F name=mcp-server-sdlc');
  });

  test('pr-merge-github — buildGithubMergeCommand shell-escapes repo (security)', async () => {
    // Defence-in-depth: even though the schema layer rejects shell metachars
    // in `repo`, the adapter must shell-escape before joining argv into a
    // shell command. The test passes a value that bypasses schema validation
    // (we call prMergeGithub directly, not the handler) and verifies the
    // resulting command contains the dangerous chars only inside a single
    // shell-quoted token.
    onExec('git remote get-url origin', 'https://github.com/cwd-org/cwd-repo.git\n');
    stubNoQueue();
    onExec('gh pr merge 99', '');
    onExec(
      'gh pr view 99',
      JSON.stringify({
        state: 'MERGED',
        url: 'https://github.com/sec/repo/pull/99',
        mergeCommit: { oid: 'abc' },
      }),
    );

    // Hostile repo value with shell-injection characters
    const hostileRepo = `sec/repo'; echo PWNED; #`;
    await prMergeGithub({ number: 99, repo: hostileRepo });

    const mergeCall = execCalls().find((c) => c.includes('gh pr merge 99'));
    expect(mergeCall).toBeDefined();
    // shellEscape wraps each argv element in `'...'` and rewrites embedded
    // single quotes as `'\''` (close + escape + reopen). The hostile value
    // becomes `'sec/repo'\''; echo PWNED; #'` — three safe shell tokens
    // joined by an escaped quote, treated as ONE argv element by the shell.
    // Strip both `'\''` sequences and `'...'` regions; no shell-active chars
    // should remain in the residual.
    const stripped = mergeCall!
      .replace(/'\\''/g, '') // remove escaped-quote sequences
      .replace(/'[^']*'/g, ''); // remove single-quoted regions
    expect(stripped).not.toContain(';');
    expect(stripped).not.toContain('echo');
    expect(stripped).not.toContain('PWNED');
  });

  // =========================================================================
  // Bug #280 / Story 2.0 (#294) — skip_train + queue-strategy error fallback
  // =========================================================================

  test('pr-merge-github — queue-strategy error triggers --auto fallback', async () => {
    // Detection returns false-negative (no queue), skip_train:true requested,
    // direct merge fails with queue-strategy error. Expected: retry with --auto
    // rather than surface gh_pr_merge_skip_train_failed to the caller.
    stubNoQueue();
    let directCalled = false;
    onExec('gh pr merge 280 --squash --delete-branch', () => {
      if (!directCalled) {
        directCalled = true;
        throw mergeQueueError();
      }
      return '';
    });
    onExec(
      'gh pr view 280 --json state,url,mergeCommit',
      JSON.stringify({
        state: 'OPEN',
        url: 'https://github.com/org/repo/pull/280',
        mergeCommit: null,
      }),
    );

    const result = await prMergeGithub({ number: 280, skip_train: true });
    expectOk(result);
    expect(result.data.merge_method).toBe('merge_queue');
    expect(result.data.enrolled).toBe(true);
    expect(result.data.queue).toEqual({ enabled: true, position: null, enforced: true });
    // The --auto retry must have fired after the queue-strategy error.
    const autoCall = execCalls().find(
      (c) => c.includes('gh pr merge 280') && c.includes('--auto'),
    );
    expect(autoCall).toBeDefined();
    // skip_train warning must be emitted (folded from the #224 preservation).
    expect(result.data.warnings.length).toBe(1);
    expect(result.data.warnings[0]).toContain('skip_train ignored');
    expect(result.data.warnings[0]).toContain('merge queue');
  });

  test('pr-merge-github — queue_fallback: true in response when fallback fires', async () => {
    // Same scenario as above but focused on the new response-shape field.
    stubNoQueue();
    let directCalled = false;
    onExec('gh pr merge 281 --squash --delete-branch', () => {
      if (!directCalled) {
        directCalled = true;
        throw mergeQueueError();
      }
      return '';
    });
    onExec(
      'gh pr view 281 --json state,url,mergeCommit',
      JSON.stringify({
        state: 'OPEN',
        url: 'https://github.com/org/repo/pull/281',
        mergeCommit: null,
      }),
    );

    const result = await prMergeGithub({ number: 281, skip_train: true });
    expectOk(result);
    expect(result.data.queue_fallback).toBe(true);
  });

  test('pr-merge-github — no fallback when merge-admin succeeds', async () => {
    // Happy path: skip_train:true + no queue enforcement + direct merge
    // succeeds synchronously. queue_fallback must stay false — the field is a
    // signal that the silent retry fired, not that skip_train was requested.
    stubNoQueue();
    onExec('gh pr merge 282 --squash --delete-branch', '');
    onExec(
      'gh pr view 282 --json state,url,mergeCommit',
      JSON.stringify({
        state: 'MERGED',
        url: 'https://github.com/org/repo/pull/282',
        mergeCommit: { oid: 'happy282' },
      }),
    );

    const result = await prMergeGithub({ number: 282, skip_train: true });
    expectOk(result);
    expect(result.data.merge_method).toBe('direct_squash');
    expect(result.data.merged).toBe(true);
    expect(result.data.queue_fallback).toBe(false);
    expect(result.data.warnings).toEqual([]);
    // No --auto call on the happy path.
    const autoCall = execCalls().find(
      (c) => c.includes('gh pr merge 282') && c.includes('--auto'),
    );
    expect(autoCall).toBeUndefined();
  });

  // =========================================================================
  // Bug #284 — GraphQL enqueuePullRequest fallback
  // =========================================================================

  test('pr-merge-github — merge queue fallback uses GraphQL enqueuePullRequest', async () => {
    // Regression bug #284: on merge-queue-on / auto-merge-off repos, both
    // direct merge AND gh pr merge --auto fail. The adapter should fall back
    // to GraphQL enqueuePullRequest mutation.
    // Register more specific matcher for enqueuePullRequest BEFORE stubNoQueue
    onExec(
      'enqueuePullRequest',
      JSON.stringify({
        data: {
          enqueuePullRequest: {
            mergeQueueEntry: { position: 3 },
          },
        },
      }),
    );
    stubNoQueue(); // detection returns false-negative
    onExec('gh pr merge 284 --squash --delete-branch', () => {
      throw mergeQueueError();
    });
    // --auto ALSO fails with a queue-related error (merge-queue-on but auto-merge-off)
    onExec('gh pr merge 284 --squash --delete-branch --auto', () => {
      const err = new Error('Auto merge is not allowed for this repository') as ThrowableError;
      err.stderr = 'Auto merge is not allowed for this repository\n';
      throw err;
    });
    // GraphQL node_id fetch
    onExec(
      'gh api repos/org/repo/pulls/284',
      JSON.stringify({ node_id: 'PR_kwDOAbc123' }),
    );
    onExec(
      'gh pr view 284 --json state,url,mergeCommit',
      JSON.stringify({
        state: 'OPEN',
        url: 'https://github.com/org/repo/pull/284',
        mergeCommit: null,
      }),
    );

    const result = await prMergeGithub({ number: 284 });
    expectOk(result);
    expect(result.data.merge_method).toBe('merge_queue');
    expect(result.data.enrolled).toBe(true);
    expect(result.data.merged).toBe(false);
    expect(result.data.queue_fallback).toBe(true);
    expect(result.data.graphql_fallback).toBe(true);
    expect(result.data.queue_position).toBe(3);
    // Verify both --auto and GraphQL calls were made
    const autoCall = execCalls().find(
      (c) => unquote(c).includes('gh pr merge 284') && unquote(c).includes('--auto'),
    );
    expect(autoCall).toBeDefined();
    const nodeIdCall = execCalls().find((c) =>
      unquote(c).includes('gh api repos/org/repo/pulls/284'),
    );
    expect(nodeIdCall).toBeDefined();
    const graphqlCall = execCalls().find(
      (c) =>
        unquote(c).includes('gh api graphql') && unquote(c).includes('enqueuePullRequest'),
    );
    expect(graphqlCall).toBeDefined();
  });

  test('pr-merge-github — GraphQL fallback shell-escapes repo and prId (security)', async () => {
    // Regression: enqueuePullRequestViaGraphQL must use argv-array form
    // (runArgv) so that special characters in `repo` or `prId` cannot break
    // out of the shell command. We verify by stubbing a node_id with chars
    // that would terminate a string-template'd command.
    onExec(
      'enqueuePullRequest',
      JSON.stringify({
        data: { enqueuePullRequest: { mergeQueueEntry: { position: 7 } } },
      }),
    );
    stubNoQueue();
    onExec('gh pr merge 286 --squash --delete-branch', () => {
      throw mergeQueueError();
    });
    onExec('gh pr merge 286 --squash --delete-branch --auto', () => {
      const err = new Error('Auto merge is not allowed for this repository') as ThrowableError;
      err.stderr = 'Auto merge is not allowed for this repository\n';
      throw err;
    });
    // node_id contains characters that WOULD break out of a quoted shell value
    onExec(
      'gh api repos/org/repo/pulls/286',
      JSON.stringify({ node_id: `PR_kw"; echo PWNED; #` }),
    );
    onExec(
      'gh pr view 286 --json state,url,mergeCommit',
      JSON.stringify({
        state: 'OPEN',
        url: 'https://github.com/org/repo/pull/286',
        mergeCommit: null,
      }),
    );

    const result = await prMergeGithub({ number: 286, repo: 'org/repo' });
    expectOk(result);
    // The dangerous prId value should appear inside single-quoted argv
    // elements, never as bare shell text. With shell-escape, every `'` in
    // the value is replaced by `'\''` and the value is wrapped in `'...'`.
    const graphqlCall = execCalls().find(
      (c) => c.includes('gh') && c.includes('graphql') && c.includes('PWNED'),
    );
    expect(graphqlCall).toBeDefined();
    // Shell-escape contract: every argv element is wrapped in `'...'` and
    // any embedded single quote is rewritten as `'\''`. The dangerous value
    // (including spaces and `; echo PWNED; #`) must be contained inside one
    // single-quoted region. We verify via a regex that captures the entire
    // single-quoted prId argv element.
    const prIdMatch = graphqlCall!.match(/'(prId=[^']*)'/);
    expect(prIdMatch).not.toBeNull();
    expect(prIdMatch![1]).toContain('PWNED');
    // Confirm there are no UNQUOTED `;` chars (which would let the shell run
    // the rest as a separate command). Strip all single-quoted regions and
    // the residual must not contain `;`.
    const residual = graphqlCall!.replace(/'[^']*'/g, '');
    expect(residual).not.toContain(';');
    expect(residual).not.toContain('echo');
  });

  test('pr-merge-github — direct merge success has graphql_fallback:false', async () => {
    // Happy path: direct merge succeeds, no GraphQL fallback needed.
    stubNoQueue();
    onExec('gh pr merge 285 --squash --delete-branch', '');
    onExec(
      'gh pr view 285 --json state,url,mergeCommit',
      JSON.stringify({
        state: 'MERGED',
        url: 'https://github.com/org/repo/pull/285',
        mergeCommit: { oid: 'abc285' },
      }),
    );

    const result = await prMergeGithub({ number: 285 });
    expectOk(result);
    expect(result.data.merge_method).toBe('direct_squash');
    expect(result.data.merged).toBe(true);
    expect(result.data.queue_fallback).toBe(false);
    expect(result.data.graphql_fallback).toBe(false);
    expect(result.data.queue_position).toBeUndefined();
  });

  test('pr-merge-github — unrelated failure surfaces error, no GraphQL fallback', async () => {
    // gh fails for a non-queue reason (e.g., CI red, conflicts). The adapter
    // should NOT invoke GraphQL enqueuePullRequest fallback, just surface the error.
    stubNoQueue();
    onExec('gh pr merge 286 --squash --delete-branch', () => {
      const err = new Error('Pull request is not mergeable: conflicts') as ThrowableError;
      err.stderr = 'Pull request is not mergeable: conflicts\n';
      throw err;
    });

    const result = await prMergeGithub({ number: 286 });
    expectErr(result);
    expect(result.code).toBe('gh_pr_merge_failed');
    expect(result.error).toContain('conflicts');
    // Queue detection GraphQL call is expected, but enqueuePullRequest should NOT be called
    const graphqlEnqueueCall = execCalls().find((c) => c.includes('enqueuePullRequest'));
    expect(graphqlEnqueueCall).toBeUndefined();
    // Also should not fetch node_id
    const nodeIdCall = execCalls().find((c) => c.includes('gh api repos/org/repo/pulls/286'));
    expect(nodeIdCall).toBeUndefined();
  });
});
