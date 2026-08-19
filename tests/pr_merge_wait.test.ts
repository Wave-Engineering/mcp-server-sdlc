import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  installChildProcessMock,
  onExec,
  resetExecMock,
  execCalls,
} from '../lib/test-support/mock-child-process.ts';

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

installChildProcessMock();

const { default: prMergeWaitHandler } = await import('../handlers/pr_merge_wait.ts');

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

beforeEach(() => {
  resetExecMock();
  onExec('git remote get-url origin', 'https://github.com/org/repo.git\n');
});

afterEach(() => {
  resetExecMock();
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
    onExec(
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
    expect(execCalls().find((c) => c.includes('gh pr merge'))).toBeUndefined();
  });

  test('#527: ok:false envelope preserves the adapter error code', async () => {
    // Drive the adapter to a typed failure: the detect-and-skip state read
    // throws, so executeMergeWait returns
    // { ok:false, code:'fetch_initial_state_failed' }. The handler used to drop
    // `code`, un-typing pr_merge_blocked / enrolled_merge_failed and every other
    // adapter failure for MCP callers; it must now surface it. Red-first: the
    // pre-fix envelope had no `code`.
    onExec('gh pr view 91 --json state,url,mergeCommit', () => {
      throw new Error('gh: PR not found');
    });
    const result = await prMergeWaitHandler.execute({ number: 91 });
    const data = parseResult(result);
    expect(data.ok).toBe(false);
    expect(data.code).toBe('fetch_initial_state_failed');
    expect(data.error).toContain('failed to read initial PR state');
  });

  test('handler exports valid HandlerDef shape', () => {
    expect(prMergeWaitHandler.name).toBe('pr_merge_wait');
    expect(typeof prMergeWaitHandler.execute).toBe('function');
  });
});
