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

// Import AFTER the mock is registered.
const { default: prMergeHandler } = await import('../handlers/pr_merge.ts');

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

beforeEach(() => {
  execRegistry = [];
  execCalls = [];
});

afterEach(() => {
  execRegistry = [];
  execCalls = [];
});

describe('pr_merge handler', () => {
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

  // --- github direct success ---
  test('github direct squash — success path returns direct_squash + merge_commit_sha', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git\n');
    onExec('gh pr merge 42 --squash --delete-branch', '');
    onExec(
      'gh pr view 42 --json mergeCommit,url',
      JSON.stringify({
        mergeCommit: { oid: 'abc123def456' },
        url: 'https://github.com/org/repo/pull/42',
      }),
    );

    const result = await prMergeHandler.execute({ number: 42 });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.number).toBe(42);
    expect(data.merged).toBe(true);
    expect(data.merge_method).toBe('direct_squash');
    expect(data.url).toBe('https://github.com/org/repo/pull/42');
    expect(data.merge_commit_sha).toBe('abc123def456');
  });

  // --- gitlab direct success ---
  test('gitlab direct squash — success path returns direct_squash + merge_commit_sha', async () => {
    onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git\n');
    onExec('glab mr merge 17 --squash --remove-source-branch --yes', '');
    onExec(
      'glab api projects/org%2Frepo/merge_requests/17',
      JSON.stringify({
        iid: 17,
        title: 'Test MR',
        description: '',
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
    expect(data.number).toBe(17);
    expect(data.merged).toBe(true);
    expect(data.merge_method).toBe('direct_squash');
    expect(data.url).toBe('https://gitlab.com/org/repo/-/merge_requests/17');
    expect(data.merge_commit_sha).toBe('deadbeef1234');
  });

  // --- merge-queue fallback ---
  test('github merge-queue fallback — direct fails with queue stderr, --auto succeeds', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git\n');

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
      'gh pr view 55 --json url',
      JSON.stringify({ url: 'https://github.com/org/repo/pull/55' }),
    );

    const result = await prMergeHandler.execute({ number: 55 });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.merge_method).toBe('merge_queue');
    expect(data.merged).toBe(true);
    expect(data.url).toBe('https://github.com/org/repo/pull/55');
    expect(data.merge_commit_sha).toBeUndefined();
    expect(directCalled).toBe(true);
    expect(autoCalled).toBe(true);
    // Confirm the second invocation carried --auto.
    const autoCall = execCalls.find(
      c => c.includes('gh pr merge 55') && c.includes('--auto'),
    );
    expect(autoCall).toBeDefined();
  });

  // --- forced merge-queue ---
  test('github forced merge-queue — use_merge_queue=true skips direct path', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git\n');
    onExec('gh pr merge 99 --squash --delete-branch --auto', '');
    onExec(
      'gh pr view 99 --json url',
      JSON.stringify({ url: 'https://github.com/org/repo/pull/99' }),
    );

    const result = await prMergeHandler.execute({ number: 99, use_merge_queue: true });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.merge_method).toBe('merge_queue');
    // Non-auto path must NOT have been invoked.
    const directOnly = execCalls.find(
      c =>
        c.startsWith('gh pr merge 99 --squash --delete-branch') && !c.includes('--auto'),
    );
    expect(directOnly).toBeUndefined();
  });

  // --- failed merge (conflicts) ---
  test('github failed merge — conflict error (no merge-queue phrase) surfaces as failure', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git\n');
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

  // --- invalid PR number ---
  test('github invalid PR — not-found error surfaces as failure', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git\n');
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

  // --- multi-line squash message (tempfile path) ---
  test('github multi-line squash message — written to temp file and passed via --body-file', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git\n');
    onExec('gh pr merge 21 --squash --delete-branch', '');
    onExec(
      'gh pr view 21 --json mergeCommit,url',
      JSON.stringify({
        mergeCommit: { oid: 'aaaaaaaa' },
        url: 'https://github.com/org/repo/pull/21',
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

    // Confirm --body-file was used (not --body with escaped newlines).
    const mergeCall = execCalls.find(c => c.startsWith('gh pr merge 21'));
    expect(mergeCall).toBeDefined();
    expect(mergeCall!).toContain('--body-file');
    expect(mergeCall!).not.toMatch(/--body\s+'feat:/);
  });

  test('github single-line squash message — passed inline via --body', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git\n');
    onExec('gh pr merge 33 --squash --delete-branch', '');
    onExec(
      'gh pr view 33 --json mergeCommit,url',
      JSON.stringify({
        mergeCommit: { oid: 'cafebabe' },
        url: 'https://github.com/org/repo/pull/33',
      }),
    );

    const result = await prMergeHandler.execute({
      number: 33,
      squash_message: 'chore: small tweak',
    });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    const mergeCall = execCalls.find(c => c.startsWith('gh pr merge 33'));
    expect(mergeCall).toBeDefined();
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
        title: 'Test MR',
        description: '',
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
    expect(mergeCall).toBeDefined();
    expect(mergeCall!).toContain("--squash-message 'fix: patch'");
  });

  // --- merge-queue fallback failure ---
  test('github merge-queue fallback — if --auto also fails, reports fallback failure', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git\n');

    let call = 0;
    onExec('gh pr merge 77 --squash --delete-branch', () => {
      call += 1;
      if (call === 1) throw mergeQueueError();
      // Second call (--auto) also fails.
      const err = new Error('auto merge not permitted') as ThrowableError;
      err.stderr = 'auto-merge is disabled on this repository\n';
      throw err;
    });

    const result = await prMergeHandler.execute({ number: 77 });
    const data = parseResult(result);

    expect(data.ok).toBe(false);
    expect((data.error as string)).toContain('merge-queue fallback');
  });

  // --- gitlab failure ---
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

  // --- skip_train: true ---
  test('github skip_train — direct merge succeeds without merge-queue fallback', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git\n');
    onExec('gh pr merge 60 --squash --delete-branch', '');
    onExec(
      'gh pr view 60 --json mergeCommit,url',
      JSON.stringify({
        mergeCommit: { oid: 'skip123' },
        url: 'https://github.com/org/repo/pull/60',
      }),
    );

    const result = await prMergeHandler.execute({ number: 60, skip_train: true });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.merge_method).toBe('direct_squash');
    expect(data.merge_commit_sha).toBe('skip123');
    // No --auto call should have been made.
    const autoCall = execCalls.find(
      c => c.includes('gh pr merge 60') && c.includes('--auto'),
    );
    expect(autoCall).toBeUndefined();
  });

  test('github skip_train — merge-queue rejection surfaces as error (no fallback)', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git\n');
    onExec('gh pr merge 61 --squash --delete-branch', () => {
      throw mergeQueueError();
    });

    const result = await prMergeHandler.execute({ number: 61, skip_train: true });
    const data = parseResult(result);

    expect(data.ok).toBe(false);
    expect((data.error as string)).toContain('skip_train');
    // Confirm no --auto fallback was attempted.
    const autoCall = execCalls.find(
      c => c.includes('gh pr merge 61') && c.includes('--auto'),
    );
    expect(autoCall).toBeUndefined();
  });

  test('github skip_train=false — preserves normal merge-queue fallback behavior', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git\n');

    let directCalled = false;
    onExec('gh pr merge 62 --squash --delete-branch', () => {
      if (!directCalled) {
        directCalled = true;
        throw mergeQueueError();
      }
      return '';
    });
    onExec(
      'gh pr view 62 --json url',
      JSON.stringify({ url: 'https://github.com/org/repo/pull/62' }),
    );

    const result = await prMergeHandler.execute({ number: 62, skip_train: false });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.merge_method).toBe('merge_queue');
    // --auto fallback WAS attempted.
    const autoCall = execCalls.find(
      c => c.includes('gh pr merge 62') && c.includes('--auto'),
    );
    expect(autoCall).toBeDefined();
  });

  test('github skip_train omitted — preserves normal merge-queue fallback behavior', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git\n');

    let directCalled = false;
    onExec('gh pr merge 63 --squash --delete-branch', () => {
      if (!directCalled) {
        directCalled = true;
        throw mergeQueueError();
      }
      return '';
    });
    onExec(
      'gh pr view 63 --json url',
      JSON.stringify({ url: 'https://github.com/org/repo/pull/63' }),
    );

    const result = await prMergeHandler.execute({ number: 63 });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.merge_method).toBe('merge_queue');
  });
});
