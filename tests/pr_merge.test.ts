import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';

// Intercept execSync via a registry keyed by command substring.
// Each value may be a plain string (returned as stdout) or a function that
// throws an Error (simulating a non-zero exit). Tests can attach `stderr` to
// the thrown error to mimic real execSync behavior.

interface ThrowableError extends Error {
  stderr?: string;
  stdout?: string;
  status?: number;
}

type Responder = string | (() => string);

let execRegistry: Array<{ match: string; respond: Responder }> = [];
let execCalls: string[] = [];

function mockExec(cmd: string): string {
  execCalls.push(cmd);
  for (const { match, respond } of execRegistry) {
    if (cmd.includes(match)) {
      return typeof respond === 'function' ? respond() : respond;
    }
  }
  throw new Error(`Unexpected exec call: ${cmd}`);
}

mock.module('child_process', () => ({
  execSync: (cmd: string, _opts?: unknown) => mockExec(cmd),
}));

const { default: prMergeHandler } = await import('../handlers/pr_merge.ts');
const { clearMergeQueueCache } = await import('../lib/merge_queue_detect.ts');

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

function onExec(match: string, respond: Responder) {
  execRegistry.push({ match, respond });
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
  execRegistry = [];
  execCalls = [];
  clearMergeQueueCache();
});

afterEach(() => {
  execRegistry = [];
  execCalls = [];
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
    expect(execCalls.find(c => c.includes('gh api graphql'))).toBeUndefined();
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
    const autoCall = execCalls.find(
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
    const directOnly = execCalls.find(
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
    const directOnly = execCalls.find(
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
    const autoCall = execCalls.find(
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
    const directOnly = execCalls.find(
      c => c.startsWith('gh pr merge 250 --squash --delete-branch') && !c.includes('--auto'),
    );
    expect(directOnly).toBeUndefined();
  });

  test('skip_train + non-enforced repo + queue stderr — surfaces error (no fallback)', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git\n');
    stubNoQueue();
    onExec('gh pr merge 202 --squash --delete-branch', () => {
      throw mergeQueueError();
    });

    const result = await prMergeHandler.execute({ number: 202, skip_train: true });
    const data = parseResult(result);

    expect(data.ok).toBe(false);
    expect((data.error as string)).toContain('skip_train');
    const autoCall = execCalls.find(
      c => c.includes('gh pr merge 202') && c.includes('--auto'),
    );
    expect(autoCall).toBeUndefined();
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
    const mergeCall = execCalls.find(c => c.startsWith('gh pr merge 21'));
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
    const mergeCall = execCalls.find(c => c.startsWith('gh pr merge 33'));
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
        merge_commit_sha: 'f00dbabe',
      }),
    );

    const result = await prMergeHandler.execute({
      number: 14,
      squash_message: 'fix: patch',
    });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    const mergeCall = execCalls.find(c => c.startsWith('glab mr merge 14'));
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

    const mergeCall = execCalls.find((c) => c.startsWith('gh pr merge 42')) ?? '';
    expect(mergeCall).toContain('--repo Wave-Engineering/mcp-server-sdlc');
    const viewCall = execCalls.find((c) => c.startsWith('gh pr view 42')) ?? '';
    expect(viewCall).toContain('--repo Wave-Engineering/mcp-server-sdlc');
    // Queue detection should also use the explicit repo, not the cwd remote.
    const graphqlCall = execCalls.find((c) => c.includes('gh api graphql')) ?? '';
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
        merge_commit_sha: 'deadbeef',
      }),
    );

    const result = await prMergeHandler.execute({
      number: 17,
      repo: 'target-org/target-repo',
    });
    const data = parseResult(result);
    expect(data.ok).toBe(true);

    const mergeCall = execCalls.find((c) => c.startsWith('glab mr merge 17')) ?? '';
    expect(mergeCall).toContain('-R target-org/target-repo');
    const apiCall = execCalls.find((c) => c.includes('glab api projects/')) ?? '';
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

    const mergeCall = execCalls.find((c) => c.startsWith('gh pr merge 42')) ?? '';
    expect(mergeCall).not.toContain('--repo');
    const viewCall = execCalls.find((c) => c.startsWith('gh pr view 42')) ?? '';
    expect(viewCall).not.toContain('--repo');
  });

  test('invalid_slug_early_error — returns ok:false with zero exec calls', async () => {
    const result = await prMergeHandler.execute({ number: 1, repo: 'bogus' });
    const data = parseResult(result);

    expect(data.ok).toBe(false);
    expect(typeof data.error).toBe('string');
    expect(execCalls).toHaveLength(0);
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

    const graphqlCalls = execCalls.filter(c => c.includes('gh api graphql'));
    expect(graphqlCalls.length).toBe(1);
  });
});
