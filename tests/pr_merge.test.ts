import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  installChildProcessMock,
  onExec,
  resetExecMock,
  execCalls,
} from '../lib/test-support/mock-child-process.ts';

// Intercept execSync via the shared child_process mock helper, keyed by command
// substring. Each registered value may be a plain string (returned as stdout)
// or a function that throws an Error (simulating a non-zero exit). Tests can
// attach `stderr` to the thrown error to mimic real execSync behavior.

interface ThrowableError extends Error {
  stderr?: string;
  stdout?: string;
  status?: number;
}

installChildProcessMock();

const { default: prMergeHandler } = await import('../handlers/pr_merge.ts');
const { clearMergeQueueCache } = await import('../lib/merge_queue_detect.ts');

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

function mergeQueueError(): ThrowableError {
  const err = new Error(
    'failed to run git: merge strategy for main is set by the merge queue',
  ) as ThrowableError;
  err.stderr =
    'failed to run git: merge strategy for main is set by the merge queue\n';
  return err;
}

// Default GraphQL stub for queue detection: respond "no queue" so old test
// expectations (direct path, stderr-fallback to queue) keep working without
// per-test boilerplate. Tests that exercise enforced-queue detection override
// this with a more specific match.
function stubNoQueue() {
  onExec(
    'gh api graphql',
    JSON.stringify({ data: { repository: { mergeQueue: null } } }),
  );
}

function stubEnforcedQueue() {
  // Match the actual GitHub GraphQL response shape: detection asks for
  // `__typename` (always-valid built-in scalar) — see #258 fix in
  // lib/merge_queue_detect.ts. The previous form returned a `mergeMethod`
  // field that doesn't exist in GitHub's schema; tests passed by accident
  // because the parser only nullness-checks the mergeQueue object.
  onExec(
    'gh api graphql',
    JSON.stringify({
      data: { repository: { mergeQueue: { __typename: 'MergeQueue' } } },
    }),
  );
}

beforeEach(() => {
  resetExecMock();
  clearMergeQueueCache();
});

afterEach(() => {
  resetExecMock();
  clearMergeQueueCache();
});

describe('pr_merge handler — aggregate response (#225)', () => {
  test('handler exports valid HandlerDef shape', () => {
    expect(prMergeHandler.name).toBe('pr_merge');
    expect(typeof prMergeHandler.execute).toBe('function');
  });

  // --- schema validation ---
  test('invalid input — missing number returns schema error', async () => {
    const result = await prMergeHandler.execute({});
    const data = parseResult(result);
    expect(data.ok).toBe(false);
    expect((data.error as string).length).toBeGreaterThan(0);
  });

  test('invalid input — negative number rejected', async () => {
    const result = await prMergeHandler.execute({ number: -1 });
    const data = parseResult(result);
    expect(data.ok).toBe(false);
  });

  // ===========================================================================
  // GitHub direct-merge path: synchronous reality (enrolled+merged+MERGED)
  // ===========================================================================

  test('github direct squash — aggregate envelope reports merged synchronously', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git\n');
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

    const result = await prMergeHandler.execute({ number: 42 });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.number).toBe(42);
    expect(data.enrolled).toBe(true);
    expect(data.merged).toBe(true);
    expect(data.merge_method).toBe('direct_squash');
    expect(data.pr_state).toBe('MERGED');
    expect(data.url).toBe('https://github.com/org/repo/pull/42');
    expect(data.merge_commit_sha).toBe('abc123def456');
    expect(data.queue).toEqual({ enabled: false, position: null, enforced: false });
    expect(data.warnings).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Regression #258 Bug 1: gh exits 0 doesn't mean "merged"
  // ---------------------------------------------------------------------------
  // When a merge queue / auto-merge is configured at the repo or branch level,
  // `gh pr merge --squash --delete-branch` may exit 0 by enrolling the PR
  // (queue add or auto-merge enable), NOT by performing the merge synchronously.
  // The handler must read actual state, not assume gh-exit-0 => merged.
  // Pre-fix behavior: line 286 hardcoded merged:true → pr_merge_wait skipped
  // its polling loop → caller believed the merge had landed when it hadn't.
  test('regression #258: direct exec exit 0 + state OPEN reports merged:false, merge_queue', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git\n');
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

    const result = await prMergeHandler.execute({ number: 99 });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.enrolled).toBe(true);
    expect(data.merged).toBe(false); // honest: gh enrolled, didn't merge
    expect(data.pr_state).toBe('OPEN');
    expect(data.merge_method).toBe('merge_queue'); // method reflects reality
    expect(data.merge_commit_sha).toBeUndefined();
  });

  // ===========================================================================
  // GitLab direct-merge path: aggregate envelope, no queue concept
  // ===========================================================================

  test('gitlab direct squash — aggregate envelope, queue stays empty', async () => {
    onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git\n');
    onExec('glab mr merge 17 --squash --remove-source-branch --yes', '');
    onExec(
      'glab api projects/org%2Frepo/merge_requests/17',
      JSON.stringify({
        iid: 17,
        state: 'merged',
        source_branch: 'feature/test',
        target_branch: 'main',
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/17',
        labels: [],
        sha: 'head17aaaaaa',
        merge_commit_sha: 'deadbeef1234',
      }),
    );

    const result = await prMergeHandler.execute({ number: 17 });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.enrolled).toBe(true);
    expect(data.merged).toBe(true);
    expect(data.merge_method).toBe('direct_squash');
    expect(data.pr_state).toBe('MERGED');
    expect(data.url).toBe('https://gitlab.com/org/repo/-/merge_requests/17');
    expect(data.merge_commit_sha).toBe('deadbeef1234');
    expect(data.queue).toEqual({ enabled: false, position: null, enforced: false });
    expect(data.warnings).toEqual([]);
    // No `gh api graphql` call should have been made on the GitLab path.
    expect(execCalls().find(c => c.includes('gh api graphql'))).toBeUndefined();
  });

  // ===========================================================================
  // GitHub queue path via stderr fallback (detection misses, legacy safety net)
  // ===========================================================================

  test('github stderr-fallback into queue — aggregate reports enrolled+OPEN', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git\n');
    stubNoQueue(); // detection returns false-negative

    let directCalled = false;
    let autoCalled = false;
    onExec('gh pr merge 55 --squash --delete-branch', () => {
      if (!directCalled) {
        directCalled = true;
        throw mergeQueueError();
      }
      autoCalled = true;
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

    const result = await prMergeHandler.execute({ number: 55 });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.enrolled).toBe(true);
    expect(data.merged).toBe(false); // queue path is eager, PR still OPEN
    expect(data.pr_state).toBe('OPEN');
    expect(data.merge_method).toBe('merge_queue');
    expect(data.merge_commit_sha).toBeUndefined();
    // The fallback path PROMOTES queue.enabled+enforced based on what we
    // learned from the stderr (detection was wrong; reality says enforced).
    expect(data.queue).toEqual({ enabled: true, position: null, enforced: true });
    expect(directCalled).toBe(true);
    expect(autoCalled).toBe(true);
    const autoCall = execCalls().find(
      c => c.includes('gh pr merge 55') && c.includes('--auto'),
    );
    expect(autoCall).toBeDefined();
  });

  // ===========================================================================
  // GitHub queue path via use_merge_queue: true (forced)
  // ===========================================================================

  test('github use_merge_queue=true — skips direct path, uses --auto', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git\n');
    stubNoQueue();
    onExec('gh pr merge 99 --squash --delete-branch --auto', '');
    onExec(
      'gh pr view 99 --json state,url,mergeCommit',
      JSON.stringify({
        state: 'OPEN',
        url: 'https://github.com/org/repo/pull/99',
        mergeCommit: null,
      }),
    );

    const result = await prMergeHandler.execute({ number: 99, use_merge_queue: true });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.enrolled).toBe(true);
    expect(data.merged).toBe(false);
    expect(data.merge_method).toBe('merge_queue');
    // Direct (non-auto) path must not have been invoked.
    const directOnly = execCalls().find(
      c =>
        c.startsWith('gh pr merge 99 --squash --delete-branch') && !c.includes('--auto'),
    );
    expect(directOnly).toBeUndefined();
  });

  // ===========================================================================
  // GitHub queue detected upfront → skips try-direct-then-fallback dance
  // ===========================================================================

  test('github detected enforced queue — goes straight to --auto, no failed direct exec', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git\n');
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

    const result = await prMergeHandler.execute({ number: 100 });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.merge_method).toBe('merge_queue');
    const queue = data.queue as { enabled: boolean; enforced: boolean };
    expect(queue.enabled).toBe(true);
    expect(queue.enforced).toBe(true);
    // Critical: NO failed direct merge call before --auto. The whole point of
    // upfront detection is to skip the wasted exec.
    const directOnly = execCalls().find(
      c =>
        c.startsWith('gh pr merge 100 --squash --delete-branch') && !c.includes('--auto'),
    );
    expect(directOnly).toBeUndefined();
  });

  // ===========================================================================
  // Part C — folded #224: skip_train graceful degrade on enforced queue
  // ===========================================================================

  test('skip_train + enforced queue — flag silently dropped, warning emitted, --auto used', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git\n');
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

    const result = await prMergeHandler.execute({ number: 200, skip_train: true });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.merge_method).toBe('merge_queue');
    expect(data.warnings).toBeArray();
    expect((data.warnings as string[]).length).toBe(1);
    expect((data.warnings as string[])[0]).toContain('skip_train ignored');
    expect((data.warnings as string[])[0]).toContain('merge queue');
  });

  test('skip_train + non-enforced repo — flag honored, direct path used, no warning', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git\n');
    stubNoQueue();
    onExec('gh pr merge 201 --squash --delete-branch', '');
    onExec(
      'gh pr view 201 --json state,url,mergeCommit',
      JSON.stringify({
        state: 'MERGED',
        url: 'https://github.com/org/repo/pull/201',
        mergeCommit: { oid: 'skip201' },
      }),
    );

    const result = await prMergeHandler.execute({ number: 201, skip_train: true });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.merge_method).toBe('direct_squash');
    expect(data.merge_commit_sha).toBe('skip201');
    expect(data.warnings).toEqual([]);
    // No --auto call.
    const autoCall = execCalls().find(
      c => c.includes('gh pr merge 201') && c.includes('--auto'),
    );
    expect(autoCall).toBeUndefined();
  });

  test('use_merge_queue:true + skip_train:true — warning emitted, queue path used', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git\n');
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

    const result = await prMergeHandler.execute({
      number: 250,
      use_merge_queue: true,
      skip_train: true,
    });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.merge_method).toBe('merge_queue');
    const warnings = data.warnings as string[];
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('skip_train ignored');
    expect(warnings[0]).toContain('use_merge_queue');
    // Direct path must not have been attempted.
    const directOnly = execCalls().find(
      c => c.startsWith('gh pr merge 250 --squash --delete-branch') && !c.includes('--auto'),
    );
    expect(directOnly).toBeUndefined();
  });

  test('skip_train + non-enforced repo + queue stderr — silently falls back to --auto (bug #280)', async () => {
    // Bug #280 / Story 2.0 (#294): when detection misses the queue upfront but
    // gh rejects the direct merge with the queue-strategy error, fold
    // skip_train into the same stderr-fallback path used for the non-skip_train
    // case. Emit the #224 skip_train-ignored warning and set queue_fallback:true
    // so callers can log the silent retry.
    onExec('git remote get-url origin', 'https://github.com/org/repo.git\n');
    stubNoQueue();
    let directCalled = false;
    onExec('gh pr merge 202 --squash --delete-branch', () => {
      if (!directCalled) {
        directCalled = true;
        throw mergeQueueError();
      }
      return '';
    });
    onExec(
      'gh pr view 202 --json state,url,mergeCommit',
      JSON.stringify({
        state: 'OPEN',
        url: 'https://github.com/org/repo/pull/202',
        mergeCommit: null,
      }),
    );

    const result = await prMergeHandler.execute({ number: 202, skip_train: true });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.merge_method).toBe('merge_queue');
    expect(data.queue_fallback).toBe(true);
    const warnings = data.warnings as string[];
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('skip_train ignored');
    const autoCall = execCalls().find(
      c => c.includes('gh pr merge 202') && c.includes('--auto'),
    );
    expect(autoCall).toBeDefined();
  });

  // ===========================================================================
  // Failure modes
  // ===========================================================================

  test('github failed merge — conflict error (non-queue) surfaces as failure', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git\n');
    stubNoQueue();
    onExec('gh pr merge 8 --squash --delete-branch', () => {
      const err = new Error(
        'Pull request is not mergeable: the base branch requires all conflicts to be resolved',
      ) as ThrowableError;
      err.stderr = 'Pull request is not mergeable: conflicts detected\n';
      throw err;
    });

    const result = await prMergeHandler.execute({ number: 8 });
    const data = parseResult(result);

    expect(data.ok).toBe(false);
    expect((data.error as string)).toContain('gh pr merge failed');
    expect((data.error as string).toLowerCase()).toContain('mergeable');
  });

  test('github invalid PR — not-found error surfaces as failure', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git\n');
    stubNoQueue();
    onExec('gh pr merge 99999 --squash --delete-branch', () => {
      const err = new Error('could not find pull request') as ThrowableError;
      err.stderr = 'GraphQL: Could not resolve to a PullRequest with the number of 99999.\n';
      throw err;
    });

    const result = await prMergeHandler.execute({ number: 99999 });
    const data = parseResult(result);

    expect(data.ok).toBe(false);
    expect((data.error as string)).toContain('gh pr merge failed');
  });

  test('github stderr-fallback failure — --auto also fails reports fallback failure', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git\n');
    stubNoQueue();

    let call = 0;
    onExec('gh pr merge 77 --squash --delete-branch', () => {
      call += 1;
      if (call === 1) throw mergeQueueError();
      const err = new Error('auto merge not permitted') as ThrowableError;
      err.stderr = 'auto-merge is disabled on this repository\n';
      throw err;
    });

    const result = await prMergeHandler.execute({ number: 77 });
    const data = parseResult(result);

    expect(data.ok).toBe(false);
    expect((data.error as string)).toContain('merge-queue fallback');
  });

  test('gitlab failed merge — error surfaces as failure', async () => {
    onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git\n');
    // #486: head-sha resolution runs before the merge, so this fixture is
    // required for the call to reach the merge failure this test asserts on.
    onExec(
      'glab api projects/org%2Frepo/merge_requests/9',
      JSON.stringify({
        iid: 9,
        state: 'opened',
        source_branch: 'feature/conflict',
        target_branch: 'main',
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/9',
        labels: [],
        sha: 'head9conflict',
        merge_commit_sha: null,
      }),
    );
    onExec('glab mr merge 9 --squash --remove-source-branch --yes', () => {
      const err = new Error('merge request cannot be merged') as ThrowableError;
      err.stderr = 'merge request has conflicts\n';
      throw err;
    });

    const result = await prMergeHandler.execute({ number: 9 });
    const data = parseResult(result);

    expect(data.ok).toBe(false);
    expect((data.error as string)).toContain('glab mr merge failed');
  });

  // ===========================================================================
  // Squash message handling
  // ===========================================================================

  test('github multi-line squash message — written to temp file via --body-file', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git\n');
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
    const result = await prMergeHandler.execute({
      number: 21,
      squash_message: body,
    });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.merge_method).toBe('direct_squash');
    const mergeCall = execCalls().find(c => c.startsWith('gh pr merge 21'));
    expect(mergeCall).toBeDefined();
    expect(mergeCall!).toContain('--body-file');
    expect(mergeCall!).not.toMatch(/--body\s+'feat:/);
  });

  test('github single-line squash message — passed inline via --body', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git\n');
    stubNoQueue();
    onExec('gh pr merge 33 --squash --delete-branch', '');
    onExec(
      'gh pr view 33 --json state,url,mergeCommit',
      JSON.stringify({
        state: 'MERGED',
        url: 'https://github.com/org/repo/pull/33',
        mergeCommit: { oid: 'cafebabe' },
      }),
    );

    const result = await prMergeHandler.execute({
      number: 33,
      squash_message: 'chore: small tweak',
    });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    const mergeCall = execCalls().find(c => c.startsWith('gh pr merge 33'));
    expect(mergeCall!).toContain("--body 'chore: small tweak'");
    expect(mergeCall!).not.toContain('--body-file');
  });

  test('gitlab squash message — passed via --squash-message', async () => {
    onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git\n');
    onExec('glab mr merge 14 --squash --remove-source-branch --yes', '');
    onExec(
      'glab api projects/org%2Frepo/merge_requests/14',
      JSON.stringify({
        iid: 14,
        state: 'merged',
        source_branch: 'feature/fix',
        target_branch: 'main',
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/14',
        labels: [],
        sha: 'head14dddddd',
        merge_commit_sha: 'f00dbabe',
      }),
    );

    const result = await prMergeHandler.execute({
      number: 14,
      squash_message: 'fix: patch',
    });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    const mergeCall = execCalls().find(c => c.startsWith('glab mr merge 14'));
    expect(mergeCall!).toContain("--squash-message 'fix: patch'");
  });

  // ===========================================================================
  // Cross-repo routing
  // ===========================================================================

  test('route_with_repo — github threads --repo into merge + view AND queue detection', async () => {
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

    const result = await prMergeHandler.execute({
      number: 42,
      repo: 'Wave-Engineering/mcp-server-sdlc',
    });
    const data = parseResult(result);
    expect(data.ok).toBe(true);

    const mergeCall = execCalls().find((c) => c.startsWith('gh pr merge 42')) ?? '';
    // shellEscape wraps the repo arg in single quotes; strip them for the
    // contains check.
    expect(mergeCall.replace(/'/g, '')).toContain('--repo Wave-Engineering/mcp-server-sdlc');
    const viewCall = execCalls().find((c) => c.startsWith('gh pr view 42')) ?? '';
    expect(viewCall.replace(/'/g, '')).toContain('--repo Wave-Engineering/mcp-server-sdlc');
    // Queue detection should also use the explicit repo, not the cwd remote.
    const graphqlCall = execCalls().find((c) => c.includes('gh api graphql')) ?? '';
    expect(graphqlCall).toContain('-F owner=Wave-Engineering');
    expect(graphqlCall).toContain('-F name=mcp-server-sdlc');
  });

  test('route_with_repo — gitlab threads -R + forwards slug to glab api', async () => {
    onExec('git remote get-url origin', 'https://gitlab.com/cwd-org/cwd-repo.git\n');
    onExec('glab mr merge 17 --squash --remove-source-branch --yes', '');
    onExec(
      'glab api projects/target-org%2Ftarget-repo/merge_requests/17',
      JSON.stringify({
        iid: 17,
        state: 'merged',
        source_branch: 'feature/test',
        target_branch: 'main',
        web_url: 'https://gitlab.com/target-org/target-repo/-/merge_requests/17',
        labels: [],
        sha: 'head17eeeeee',
        merge_commit_sha: 'deadbeef',
      }),
    );

    const result = await prMergeHandler.execute({
      number: 17,
      repo: 'target-org/target-repo',
    });
    const data = parseResult(result);
    expect(data.ok).toBe(true);

    const mergeCall = execCalls().find((c) => c.startsWith('glab mr merge 17')) ?? '';
    expect(mergeCall).toContain("-R 'target-org/target-repo'");
    const apiCall = execCalls().find((c) => c.includes('glab api projects/')) ?? '';
    expect(apiCall).toContain('target-org%2Ftarget-repo');
    expect(apiCall).not.toContain('cwd-org%2Fcwd-repo');
  });

  test('regression_without_repo — gh pr merge does not contain --repo', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git\n');
    stubNoQueue();
    onExec('gh pr merge 42 --squash --delete-branch', '');
    onExec(
      'gh pr view 42 --json state,url,mergeCommit',
      JSON.stringify({
        state: 'MERGED',
        url: 'https://github.com/org/repo/pull/42',
        mergeCommit: { oid: 'x' },
      }),
    );

    await prMergeHandler.execute({ number: 42 });

    const mergeCall = execCalls().find((c) => c.startsWith('gh pr merge 42')) ?? '';
    expect(mergeCall).not.toContain('--repo');
    const viewCall = execCalls().find((c) => c.startsWith('gh pr view 42')) ?? '';
    expect(viewCall).not.toContain('--repo');
  });

  test('invalid_slug_early_error — returns ok:false with zero exec calls', async () => {
    const result = await prMergeHandler.execute({ number: 1, repo: 'bogus' });
    const data = parseResult(result);

    expect(data.ok).toBe(false);
    expect(typeof data.error).toBe('string');
    expect(execCalls()).toHaveLength(0);
  });

  // ===========================================================================
  // Queue detection caching: verify one GraphQL call for repeat invocations
  // ===========================================================================

  test('queue detection cached per repo — second pr_merge skips graphql call', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git\n');
    stubEnforcedQueue();
    onExec('gh pr merge ', '');  // matches both 301 and 302 since both start "gh pr merge "
    onExec(
      'gh pr view ',
      JSON.stringify({
        state: 'OPEN',
        url: 'https://github.com/org/repo/pull/?',
        mergeCommit: null,
      }),
    );

    await prMergeHandler.execute({ number: 301 });
    await prMergeHandler.execute({ number: 302 });

    const graphqlCalls = execCalls().filter(c => c.includes('gh api graphql'));
    expect(graphqlCalls.length).toBe(1);
  });
});

// ===========================================================================
// #497 — branch-delete failure after a successful merge reports ok:true
// ===========================================================================
//
// `gh pr merge --delete-branch` performs merge then deletion in one command.
// If deletion fails AFTER the merge commits the whole command exits non-zero.
// The two outcomes demand opposite caller responses and must not be conflated:
//   - merge failed → ok:false (caller must stop and surface the error)
//   - merge landed, deletion failed → ok:true with warning (caller proceeds)

describe('#497 — branch-delete failure after successful merge', () => {
  function branchDeleteError(prNumber: number): ThrowableError {
    const err = new Error(
      `failed to delete remote branch fix/${prNumber}-foo: HTTP 503: No server is currently available to handle this request.`,
    ) as ThrowableError;
    err.stderr = err.message;
    err.status = 1;
    return err;
  }

  test('branch-delete failure + merge confirmed → ok:true with warning', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git\n');
    stubNoQueue();
    onExec('gh pr merge 930 --squash --delete-branch', () => {
      throw branchDeleteError(930);
    });
    // fetchPrState via the gh pr view path
    onExec(
      'gh pr view 930 --json state,url,mergeCommit',
      JSON.stringify({
        state: 'MERGED',
        url: 'https://github.com/org/repo/pull/930',
        mergeCommit: { oid: 'bae1b8d' },
      }),
    );

    const result = await prMergeHandler.execute({ number: 930 });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.merged).toBe(true);
    expect(data.merge_method).toBe('direct_squash');
    expect(data.merge_commit_sha).toBe('bae1b8d');
    // Warning must be present and name the deletion failure
    expect(Array.isArray(data.warnings)).toBe(true);
    const w = (data.warnings as string[]).join(' ');
    expect(w).toMatch(/branch deletion failed/i);
    expect(w).toMatch(/HTTP 503/);
  });

  test('branch-delete failure + merge NOT confirmed → ok:false (normal error path)', async () => {
    // If after the deletion error the PR is still OPEN (merge didn't land),
    // we must NOT swallow the error — fall through to ok:false.
    onExec('git remote get-url origin', 'https://github.com/org/repo.git\n');
    stubNoQueue();
    onExec('gh pr merge 931 --squash --delete-branch', () => {
      throw branchDeleteError(931);
    });
    onExec(
      'gh pr view 931 --json state,url,mergeCommit',
      JSON.stringify({
        state: 'OPEN',
        url: 'https://github.com/org/repo/pull/931',
        mergeCommit: null,
      }),
    );

    const result = await prMergeHandler.execute({ number: 931 });
    const data = parseResult(result);

    // The merge did not land — caller must see ok:false
    expect(data.ok).toBe(false);
  });

  test('branch-delete failure + fetchPrState throws → falls through to ok:false', async () => {
    // If the confirmation call itself fails, we have no information — report
    // the original error rather than silently returning ok:true.
    onExec('git remote get-url origin', 'https://github.com/org/repo.git\n');
    stubNoQueue();
    onExec('gh pr merge 932 --squash --delete-branch', () => {
      throw branchDeleteError(932);
    });
    onExec('gh pr view 932 --json state,url,mergeCommit', () => {
      const err = new Error('HTTP 500') as ThrowableError;
      err.stderr = 'HTTP 500';
      err.status = 1;
      throw err;
    });

    const result = await prMergeHandler.execute({ number: 932 });
    const data = parseResult(result);

    expect(data.ok).toBe(false);
  });

  test('unrelated merge failure is not misclassified as branch-delete', async () => {
    // A plain merge failure (e.g. "not mergeable") must stay ok:false without
    // triggering the branch-delete recovery path.
    onExec('git remote get-url origin', 'https://github.com/org/repo.git\n');
    stubNoQueue();
    onExec('gh pr merge 933 --squash --delete-branch', () => {
      const err = new Error('Pull request is not mergeable') as ThrowableError;
      err.stderr = 'Pull request is not mergeable';
      err.status = 1;
      throw err;
    });

    const result = await prMergeHandler.execute({ number: 933 });
    const data = parseResult(result);

    expect(data.ok).toBe(false);
    // Must not have reached fetchPrState
    const viewCalls = execCalls().filter((c) => c.includes('gh pr view 933'));
    expect(viewCalls).toHaveLength(0);
  });
});

// ===========================================================================
// #461 — GitLab blocked MR surfaces the blocker instead of an ambiguous
// enrolled:true/merged:false shape
// ===========================================================================
//
// `glab mr merge` can exit 0 without merging (e.g. blocked on required
// approvals, unresolved discussions, or draft status). Pre-#461 that read
// back as `enrolled:true, merged:false` — indistinguishable from legitimate
// merge-queue enrollment, even though GitLab has no queue concept. The
// caller had to round-trip pr_status to learn why. This reuses
// `normalizeGitlabMergeState` (the canonical classification already used by
// pr_status) to surface `detailed_merge_status` directly, for every
// terminal blocker that classification recognizes — not just approvals.

describe('#461 — GitLab blocked merge surfaces the blocker', () => {
  test('not_approved MR → enrolled:false with an explicit warning', async () => {
    onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git\n');
    onExec('glab mr merge 84 --squash --remove-source-branch --yes', '');
    // Every gitlabApiMr call (resolveHeadSha, the unified #424/#461 poll)
    // hits this same endpoint — one consistent MR shape services both.
    onExec(
      'glab api projects/org%2Frepo/merge_requests/84',
      JSON.stringify({
        iid: 84,
        state: 'opened',
        detailed_merge_status: 'not_approved',
        source_branch: 'feature/test',
        target_branch: 'main',
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/84',
        labels: [],
        sha: 'head84aaaaaa',
        merge_commit_sha: null,
      }),
    );

    const result = await prMergeHandler.execute({ number: 84 });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.merged).toBe(false);
    // The core of #461: a blocked MR is not enrollment.
    expect(data.enrolled).toBe(false);
    expect(data.pr_state).toBe('OPEN');
    const w = (data.warnings as string[]).join(' ');
    expect(w).toMatch(/not_approved/);
    // #424: a genuinely blocked MR must stop polling immediately rather than
    // burning the full poll budget on a state that will never resolve to
    // merged — resolveHeadSha (1) + one poll read that classifies blocked (1).
    const apiCalls = execCalls().filter((c) => c.includes('merge_requests/84'));
    expect(apiCalls).toHaveLength(2);
  });

  test('discussions_not_resolved → also enrolled:false (not just not_approved)', async () => {
    // Regression guard for the code-review finding: the first cut of this
    // fix keyed on the literal 'not_approved' only, leaving every OTHER
    // terminal blocker in pr-status-gitlab.ts's own classification
    // (discussions_not_resolved, draft_status, blocked_status, ci_must_pass)
    // still reporting the ambiguous enrolled:true shape.
    onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git\n');
    onExec('glab mr merge 87 --squash --remove-source-branch --yes', '');
    onExec(
      'glab api projects/org%2Frepo/merge_requests/87',
      JSON.stringify({
        iid: 87,
        state: 'opened',
        detailed_merge_status: 'discussions_not_resolved',
        source_branch: 'feature/test',
        target_branch: 'main',
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/87',
        labels: [],
        sha: 'head87aaaaaa',
        merge_commit_sha: null,
      }),
    );

    const result = await prMergeHandler.execute({ number: 87 });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.enrolled).toBe(false);
    const w = (data.warnings as string[]).join(' ');
    expect(w).toMatch(/discussions_not_resolved/);
  });

  test('unmerged for a genuinely in-progress reason → no false warning', async () => {
    // A merge that simply has not landed yet for an in-progress reason (still
    // checking mergeability) must not be mislabeled as blocked — this is the
    // 'unknown' bucket in normalizeGitlabMergeState, not 'blocked'.
    onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git\n');
    onExec('glab mr merge 85 --squash --remove-source-branch --yes', '');
    onExec(
      'glab api projects/org%2Frepo/merge_requests/85',
      JSON.stringify({
        iid: 85,
        state: 'opened',
        detailed_merge_status: 'checking',
        source_branch: 'feature/test',
        target_branch: 'main',
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/85',
        labels: [],
        sha: 'head85aaaaaa',
        merge_commit_sha: null,
      }),
    );

    const result = await prMergeHandler.execute({ number: 85 });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.merged).toBe(false);
    // Genuinely in progress — the pre-#461 enrolled:true shape is still correct.
    expect(data.enrolled).toBe(true);
    expect(data.warnings).toEqual([]);
  });

  test('a state read fails mid-poll → ok:false, not silently swallowed', async () => {
    // #424 unified the #461 blocked-reason check into the SAME poll that
    // resolves the merge race — there is no longer a separate, purely
    // cosmetic diagnostic call whose failure can be shrugged off. A failed
    // read now genuinely means "we don't know whether it merged or is
    // blocked", which must surface as ok:false rather than a guessed shape.
    // Call 1 = resolveHeadSha. Call 2 = poll's first read, ambiguous
    // ('checking' — neither merged nor blocked, so the loop continues).
    // Call 3 = the retry — this one fails.
    onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git\n');
    onExec('glab mr merge 88 --squash --remove-source-branch --yes', '');
    let apiCallCount = 0;
    onExec('glab api projects/org%2Frepo/merge_requests/88', () => {
      apiCallCount += 1;
      if (apiCallCount >= 3) {
        const err = new Error('glab api: HTTP 500') as ThrowableError;
        err.stderr = 'HTTP 500';
        err.status = 1;
        throw err;
      }
      return JSON.stringify({
        iid: 88,
        state: 'opened',
        detailed_merge_status: 'checking',
        source_branch: 'feature/test',
        target_branch: 'main',
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/88',
        labels: [],
        sha: 'head88aaaaaa',
        merge_commit_sha: null,
      });
    });

    const result = await prMergeHandler.execute({ number: 88 });
    const data = parseResult(result);

    expect(data.ok).toBe(false);
    // The whole point of a typed code: a caller must be able to tell "the
    // merge command succeeded but state confirmation failed" from "the merge
    // genuinely failed" WITHOUT string-matching error text. If the handler
    // ever drops `code` again (as it did until this same PR fixed
    // handlers/pr_merge.ts:61), this assertion catches it immediately.
    expect(data.code).toBe('gitlab_mr_state_fetch_failed');
    expect(apiCallCount).toBe(3);
  });

  test('a genuinely merged MR is unaffected — no re-check, no warning', async () => {
    onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git\n');
    onExec('glab mr merge 86 --squash --remove-source-branch --yes', '');
    onExec(
      'glab api projects/org%2Frepo/merge_requests/86',
      JSON.stringify({
        iid: 86,
        state: 'merged',
        detailed_merge_status: 'mergeable',
        source_branch: 'feature/test',
        target_branch: 'main',
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/86',
        labels: [],
        sha: 'head86aaaaaa',
        merge_commit_sha: 'cafebabe1234',
      }),
    );

    const result = await prMergeHandler.execute({ number: 86 });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.merged).toBe(true);
    expect(data.enrolled).toBe(true);
    expect(data.warnings).toEqual([]);
    // The title's claim, made assertable: exactly resolveHeadSha + one poll
    // read — the poll stops immediately on seeing `merged`.
    const apiCalls = execCalls().filter((c) => c.includes('merge_requests/86'));
    expect(apiCalls).toHaveLength(2);
  });

  test('conflict (dirty, not blocked) → enrolled stays true, no warning', async () => {
    // Pins the other side of the classification boundary: `conflict` maps to
    // 'dirty' in normalizeGitlabMergeState, not 'blocked' — a future widening
    // of the blocked bucket must not silently swallow this case too.
    onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git\n');
    onExec('glab mr merge 89 --squash --remove-source-branch --yes', '');
    onExec(
      'glab api projects/org%2Frepo/merge_requests/89',
      JSON.stringify({
        iid: 89,
        state: 'opened',
        detailed_merge_status: 'conflict',
        source_branch: 'feature/test',
        target_branch: 'main',
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/89',
        labels: [],
        sha: 'head89aaaaaa',
        merge_commit_sha: null,
      }),
    );

    const result = await prMergeHandler.execute({ number: 89 });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.merged).toBe(false);
    expect(data.enrolled).toBe(true);
    expect(data.warnings).toEqual([]);
  });
});

// ===========================================================================
// #497 (GitLab) — branch-delete failure after a successful merge reports
// ok:true, mirroring the GitHub coverage above
// ===========================================================================

describe('#497 (GitLab) — branch-delete failure after successful merge', () => {
  test('branch-delete failure + MR confirmed merged → ok:true with warning', async () => {
    onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git\n');
    onExec('glab mr merge 90 --squash --remove-source-branch --yes', () => {
      const err = new Error(
        'could not delete source branch fix/90-foo: 500 Internal Server Error',
      ) as ThrowableError;
      err.stderr = err.message;
      err.status = 1;
      throw err;
    });
    // resolveHeadSha's pre-merge read, then pollPostMergeState's post-failure
    // read — both see the same already-merged MR.
    onExec(
      'glab api projects/org%2Frepo/merge_requests/90',
      JSON.stringify({
        iid: 90,
        state: 'merged',
        detailed_merge_status: 'mergeable',
        source_branch: 'feature/test',
        target_branch: 'main',
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/90',
        labels: [],
        sha: 'head90aaaaaa',
        merge_commit_sha: 'deadbeef9090',
      }),
    );

    const result = await prMergeHandler.execute({ number: 90 });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.merged).toBe(true);
    expect(data.merge_commit_sha).toBe('deadbeef9090');
    const w = (data.warnings as string[]).join(' ');
    expect(w).toMatch(/branch deletion failed/i);
    expect(w).toMatch(/500/);
  });

  test('branch-delete failure + state read races (settles merged on retry) → ok:true, not ok:false', async () => {
    // Code-review finding (Important #2): this path used a SINGLE unretried
    // read before #424, exposing it to the identical propagation-lag race —
    // and a lagged read here would have been WORSE than the bug #424 fixes:
    // it would report `glab_mr_merge_failed` (ok:false) for a merge that
    // actually landed, using a branch-deletion error as the stated cause.
    // Now reuses pollPostMergeState, so a race that resolves within the poll
    // budget is caught here exactly as it is on the main merge-success path.
    onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git\n');
    onExec('glab mr merge 95 --squash --remove-source-branch --yes', () => {
      const err = new Error(
        'could not delete source branch fix/95-foo: 500 Internal Server Error',
      ) as ThrowableError;
      err.stderr = err.message;
      err.status = 1;
      throw err;
    });
    let apiCallCount = 0;
    onExec('glab api projects/org%2Frepo/merge_requests/95', () => {
      apiCallCount += 1;
      // Call 1 = resolveHeadSha. Call 2 = the post-failure poll's first read
      // (still racing). Call 3 = the retry, which sees the settled state.
      const state = apiCallCount >= 3 ? 'merged' : 'opened';
      return JSON.stringify({
        iid: 95,
        state,
        detailed_merge_status: state === 'merged' ? 'mergeable' : 'checking',
        source_branch: 'feature/test',
        target_branch: 'main',
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/95',
        labels: [],
        sha: 'head95aaaaaa',
        merge_commit_sha: state === 'merged' ? 'deadbeef9595' : null,
      });
    });

    const result = await prMergeHandler.execute({ number: 95 });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.merged).toBe(true);
    expect(data.merge_commit_sha).toBe('deadbeef9595');
    const w = (data.warnings as string[]).join(' ');
    expect(w).toMatch(/branch deletion failed/i);
    expect(apiCallCount).toBe(3);
  }, 10000);

  test('branch-delete failure + MR NOT confirmed merged → ok:false', async () => {
    onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git\n');
    onExec('glab mr merge 91 --squash --remove-source-branch --yes', () => {
      const err = new Error(
        'could not delete source branch fix/91-foo: 500 Internal Server Error',
      ) as ThrowableError;
      err.stderr = err.message;
      err.status = 1;
      throw err;
    });
    onExec(
      'glab api projects/org%2Frepo/merge_requests/91',
      JSON.stringify({
        iid: 91,
        state: 'opened',
        detailed_merge_status: 'not_approved',
        source_branch: 'feature/test',
        target_branch: 'main',
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/91',
        labels: [],
        sha: 'head91aaaaaa',
        merge_commit_sha: null,
      }),
    );

    const result = await prMergeHandler.execute({ number: 91 });
    const data = parseResult(result);

    // The merge did not land — must not be swallowed as a success.
    expect(data.ok).toBe(false);
  });
});

// ===========================================================================
// #424 — GitLab merge-state read-after-write race: poll before trusting a
// not-yet-merged read
// ===========================================================================
//
// `glab mr merge` can exit 0 and the merge genuinely land, but GitLab's own
// state read lags by a beat — the very next MR read still shows `opened`.
// Reproduced live: two parallel MRs in the same wave flight, one read back
// `merged:true` immediately, the other (merged moments EARLIER by wall
// clock) read back `merged:false`. A single unretried read cannot tell
// "still racing" from "genuinely not merged" — pollPostMergeState retries
// briefly before trusting a not-merged read, and stops the moment the MR
// classifies as genuinely blocked rather than burning the whole budget.

describe('#424 — GitLab merge-state poll resolves the read-after-write race', () => {
  test('state settles to merged on the SECOND read → merged:true, no error', async () => {
    onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git\n');
    onExec('glab mr merge 92 --squash --remove-source-branch --yes', '');
    let apiCallCount = 0;
    onExec('glab api projects/org%2Frepo/merge_requests/92', () => {
      apiCallCount += 1;
      // Call 1 = resolveHeadSha (pre-merge). Call 2 = the poll's first read
      // (still racing — GitLab hasn't caught up). Call 3 = the poll's retry,
      // which sees the settled state.
      const state = apiCallCount >= 3 ? 'merged' : 'opened';
      return JSON.stringify({
        iid: 92,
        state,
        detailed_merge_status: state === 'merged' ? 'mergeable' : 'checking',
        source_branch: 'feature/test',
        target_branch: 'main',
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/92',
        labels: [],
        sha: 'head92aaaaaa',
        merge_commit_sha: state === 'merged' ? 'deadbeef9292' : null,
      });
    });

    const result = await prMergeHandler.execute({ number: 92 });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.merged).toBe(true);
    expect(data.merge_commit_sha).toBe('deadbeef9292');
    expect(data.enrolled).toBe(true);
    expect(data.warnings).toEqual([]);
    // Exactly resolveHeadSha + 2 poll reads — the loop must stop as soon as
    // it sees 'merged', not run the full attempt budget.
    expect(apiCallCount).toBe(3);
  }, 10000);

  test('state never settles within the budget → falls through to the honest not-merged shape', async () => {
    onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git\n');
    onExec('glab mr merge 93 --squash --remove-source-branch --yes', '');
    let apiCallCount = 0;
    onExec('glab api projects/org%2Frepo/merge_requests/93', () => {
      apiCallCount += 1;
      // Never settles — simulates a genuinely slow-to-propagate MR (or one
      // that really is just still checking), distinct from a permanently
      // blocked one.
      return JSON.stringify({
        iid: 93,
        state: 'opened',
        detailed_merge_status: 'checking',
        source_branch: 'feature/test',
        target_branch: 'main',
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/93',
        labels: [],
        sha: 'head93aaaaaa',
        merge_commit_sha: null,
      });
    });

    const result = await prMergeHandler.execute({ number: 93 });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.merged).toBe(false);
    // 'checking' is 'unknown', not 'blocked' — still honestly enrolled:true,
    // matching the pre-#424 shape for a call that exhausts the poll budget.
    expect(data.enrolled).toBe(true);
    expect(data.warnings).toEqual([]);
    // resolveHeadSha (1) + the full poll budget (4 attempts) = 5. Proves the
    // poll ran its full attempt budget rather than giving up early or
    // looping forever. No trailing diagnostic call — #424 unified the
    // blocked-reason check into the same poll reads.
    expect(apiCallCount).toBe(5);
  }, 10000);

  test('a state-read error on the first read short-circuits — no retry, no added delay', async () => {
    onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git\n');
    onExec('glab mr merge 94 --squash --remove-source-branch --yes', '');
    let apiCallCount = 0;
    onExec('glab api projects/org%2Frepo/merge_requests/94', () => {
      apiCallCount += 1;
      if (apiCallCount === 1) {
        // resolveHeadSha must still succeed — the merge command needs a sha.
        return JSON.stringify({
          iid: 94,
          state: 'opened',
          source_branch: 'feature/test',
          target_branch: 'main',
          web_url: 'https://gitlab.com/org/repo/-/merge_requests/94',
          labels: [],
          sha: 'head94aaaaaa',
          merge_commit_sha: null,
        });
      }
      // The post-merge state read fails outright (not a race — a real error).
      const err = new Error('glab api: HTTP 503') as ThrowableError;
      err.stderr = 'HTTP 503';
      err.status = 1;
      throw err;
    });

    const result = await prMergeHandler.execute({ number: 94 });
    const data = parseResult(result);

    // A genuine fetch error is not the propagation race this poll exists
    // for — it must surface immediately, not retry against a dead endpoint.
    expect(data.ok).toBe(false);
    // resolveHeadSha (1) + exactly ONE failed poll attempt — no retries.
    expect(apiCallCount).toBe(2);
  });
});
