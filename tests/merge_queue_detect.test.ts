import { describe, test, expect, mock, beforeEach } from 'bun:test';

let execCalls: string[] = [];
let execMockFn: (cmd: string) => string = () => '';
const mockExecSync = mock((cmd: string) => {
  execCalls.push(cmd);
  return execMockFn(cmd);
});
mock.module('child_process', () => ({ execSync: mockExecSync }));

const { detectMergeQueue, clearMergeQueueCache } = await import(
  '../lib/merge_queue_detect.ts'
);

function reset() {
  execCalls = [];
  execMockFn = () => '';
  mockExecSync.mockClear();
  clearMergeQueueCache();
}

describe('merge_queue_detect', () => {
  beforeEach(() => reset());

  test('returns enabled+enforced when GraphQL reports a merge queue', () => {
    execMockFn = () =>
      JSON.stringify({ data: { repository: { mergeQueue: { mergeMethod: 'SQUASH' } } } });
    const info = detectMergeQueue('Wave-Engineering/claudecode-workflow');
    expect(info.enabled).toBe(true);
    expect(info.enforced).toBe(true);
    expect(info.method).toBe('SQUASH');
  });

  test('returns disabled when GraphQL reports null mergeQueue', () => {
    execMockFn = () => JSON.stringify({ data: { repository: { mergeQueue: null } } });
    const info = detectMergeQueue('org/no-queue-repo');
    expect(info.enabled).toBe(false);
    expect(info.enforced).toBe(false);
    expect(info.method).toBeUndefined();
  });

  test('caches result per repo for the process lifetime', () => {
    execMockFn = () =>
      JSON.stringify({ data: { repository: { mergeQueue: { mergeMethod: 'MERGE' } } } });
    detectMergeQueue('org/repo-a');
    detectMergeQueue('org/repo-a');
    detectMergeQueue('org/repo-a');
    // One graphql call across three lookups for the same slug
    expect(execCalls.length).toBe(1);
  });

  test('different repos get independent cache entries', () => {
    let n = 0;
    execMockFn = () => {
      n += 1;
      return JSON.stringify({
        data: { repository: { mergeQueue: n === 1 ? { mergeMethod: 'SQUASH' } : null } },
      });
    };
    const a = detectMergeQueue('org/repo-a');
    const b = detectMergeQueue('org/repo-b');
    expect(a.enabled).toBe(true);
    expect(b.enabled).toBe(false);
    expect(execCalls.length).toBe(2);
  });

  test('clearMergeQueueCache forces a refetch', () => {
    execMockFn = () => JSON.stringify({ data: { repository: { mergeQueue: null } } });
    detectMergeQueue('org/repo');
    clearMergeQueueCache();
    detectMergeQueue('org/repo');
    expect(execCalls.length).toBe(2);
  });

  test('GraphQL failure yields conservative {enabled:false, enforced:false}', () => {
    execMockFn = () => {
      throw new Error('gh: not authenticated');
    };
    const info = detectMergeQueue('org/repo');
    expect(info.enabled).toBe(false);
    expect(info.enforced).toBe(false);
  });

  test('failure result is cached (no retry storms)', () => {
    execMockFn = () => {
      throw new Error('boom');
    };
    detectMergeQueue('org/repo');
    detectMergeQueue('org/repo');
    expect(execCalls.length).toBe(1);
  });

  test('malformed slug (no slash) returns {enabled:false} without exec', () => {
    const info = detectMergeQueue('not-a-slug');
    expect(info.enabled).toBe(false);
    expect(execCalls.length).toBe(0);
  });

  test('shell-metacharacter slug rejected without exec', () => {
    const info = detectMergeQueue('org/repo;rm -rf /');
    expect(info.enabled).toBe(false);
    expect(execCalls.length).toBe(0);
  });

  test('passes owner+name as -F flags, not interpolated into the query', () => {
    execMockFn = () => JSON.stringify({ data: { repository: { mergeQueue: null } } });
    detectMergeQueue('Wave-Engineering/mcp-server-sdlc');
    expect(execCalls[0]).toContain('-F owner=Wave-Engineering');
    expect(execCalls[0]).toContain('-F name=mcp-server-sdlc');
    // owner/name MUST NOT appear inline in the GraphQL query string —
    // the parameterized form is the safe way to pass user-controlled values.
    const queryFragment = execCalls[0].match(/'query=([^']+)'/)?.[1] ?? '';
    expect(queryFragment).not.toContain('Wave-Engineering');
    expect(queryFragment).not.toContain('mcp-server-sdlc');
  });
});
