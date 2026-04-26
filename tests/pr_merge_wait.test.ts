import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';

// Thin handler-level smoke tests for pr_merge_wait. Story 1.11 (#248) moved
// the orchestration tests to lib/adapters/pr-merge-wait-{github,gitlab}.test.ts
// and the pure poll-loop tests to lib/pr-merge-wait-poll.test.ts. The handler
// is now a ~50-line dispatcher; these tests cover only:
//   - schema validation (zod rejection paths)
//   - the HandlerDef export shape
//   - end-to-end envelope wiring (one happy-path detect-and-skip case)
//
// Each test file installs its OWN mock.module BEFORE the dynamic import
// (56-file convention).

interface ThrowableError extends Error {
  stderr?: string;
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
  throw err;
});

mock.module('child_process', () => ({ execSync: mockExecSync }));

const { default: prMergeWaitHandler } = await import('../handlers/pr_merge_wait.ts');

function on(match: string, respond: string | (() => string)) {
  execRegistry.push({ match, respond });
}

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

beforeEach(() => {
  execRegistry = [];
  execCalls = [];
  on('git remote get-url origin', 'https://github.com/org/repo.git\n');
});

afterEach(() => {
  execRegistry = [];
  execCalls = [];
});

describe('pr_merge_wait handler — thin dispatcher', () => {
  test('schema rejection: missing number', async () => {
    const result = await prMergeWaitHandler.execute({});
    const data = parseResult(result);
    expect(data.ok).toBe(false);
  });

  test('schema rejection: timeout_sec must be positive', async () => {
    const result = await prMergeWaitHandler.execute({ number: 1, timeout_sec: -5 });
    const data = parseResult(result);
    expect(data.ok).toBe(false);
  });

  test('end-to-end envelope: detect-and-skip path returns ok:true with merged:true', async () => {
    on(
      'gh pr view 50 --json state,url,mergeCommit',
      JSON.stringify({
        state: 'MERGED',
        url: 'https://github.com/org/repo/pull/50',
        mergeCommit: { oid: 'preexisting' },
      }),
    );

    const result = await prMergeWaitHandler.execute({ number: 50 });
    const data = parseResult(result);
    expect(data.ok).toBe(true);
    expect(data.merged).toBe(true);
    expect(data.pr_state).toBe('MERGED');
    expect(data.merge_commit_sha).toBe('preexisting');
    // No merge call should have been issued — detect-and-skip short-circuits.
    expect(execCalls.find((c) => c.includes('gh pr merge'))).toBeUndefined();
  });

  test('handler exports valid HandlerDef shape', () => {
    expect(prMergeWaitHandler.name).toBe('pr_merge_wait');
    expect(typeof prMergeWaitHandler.execute).toBe('function');
  });
});
