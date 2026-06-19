import { describe, test, expect, beforeEach } from 'bun:test';
import {
  installChildProcessMock,
  setExecMock,
  resetExecMock,
  execCalls,
} from '../lib/test-support/mock-child-process.ts';

installChildProcessMock();

const { detectMergeQueue, clearMergeQueueCache } = await import(
  '../lib/merge_queue_detect.ts'
);

function reset() {
  resetExecMock();
  setExecMock(() => '');
  clearMergeQueueCache();
}

describe('merge_queue_detect', () => {
  beforeEach(() => reset());

  test('returns enabled+enforced when GraphQL reports a merge queue', () => {
    setExecMock(() =>
      JSON.stringify({ data: { repository: { mergeQueue: { __typename: 'MergeQueue' } } } }));
    const info = detectMergeQueue('Wave-Engineering/claudecode-workflow');
    expect(info.enabled).toBe(true);
    expect(info.enforced).toBe(true);
  });

  test('returns disabled when GraphQL reports null mergeQueue', () => {
    setExecMock(() => JSON.stringify({ data: { repository: { mergeQueue: null } } }));
    const info = detectMergeQueue('org/no-queue-repo');
    expect(info.enabled).toBe(false);
    expect(info.enforced).toBe(false);
  });

  test('caches result per repo for the process lifetime', () => {
    setExecMock(() =>
      JSON.stringify({ data: { repository: { mergeQueue: { __typename: 'MergeQueue' } } } }));
    detectMergeQueue('org/repo-a');
    detectMergeQueue('org/repo-a');
    detectMergeQueue('org/repo-a');
    // One graphql call across three lookups for the same slug
    expect(execCalls().length).toBe(1);
  });

  test('different repos get independent cache entries', () => {
    let n = 0;
    setExecMock(() => {
      n += 1;
      return JSON.stringify({
        data: { repository: { mergeQueue: n === 1 ? { __typename: 'MergeQueue' } : null } },
      });
    });
    const a = detectMergeQueue('org/repo-a');
    const b = detectMergeQueue('org/repo-b');
    expect(a.enabled).toBe(true);
    expect(b.enabled).toBe(false);
    expect(execCalls().length).toBe(2);
  });

  test('clearMergeQueueCache forces a refetch', () => {
    setExecMock(() => JSON.stringify({ data: { repository: { mergeQueue: null } } }));
    detectMergeQueue('org/repo');
    clearMergeQueueCache();
    detectMergeQueue('org/repo');
    expect(execCalls().length).toBe(2);
  });

  test('GraphQL failure yields conservative {enabled:false, enforced:false}', () => {
    setExecMock(() => {
      throw new Error('gh: not authenticated');
    });
    const info = detectMergeQueue('org/repo');
    expect(info.enabled).toBe(false);
    expect(info.enforced).toBe(false);
  });

  test('failure result is cached (no retry storms)', () => {
    setExecMock(() => {
      throw new Error('boom');
    });
    detectMergeQueue('org/repo');
    detectMergeQueue('org/repo');
    expect(execCalls().length).toBe(1);
  });

  test('malformed slug (no slash) returns {enabled:false} without exec', () => {
    const info = detectMergeQueue('not-a-slug');
    expect(info.enabled).toBe(false);
    expect(execCalls().length).toBe(0);
  });

  test('shell-metacharacter slug rejected without exec', () => {
    const info = detectMergeQueue('org/repo;rm -rf /');
    expect(info.enabled).toBe(false);
    expect(execCalls().length).toBe(0);
  });

  test('passes owner+name as -F flags, not interpolated into the query', () => {
    setExecMock(() => JSON.stringify({ data: { repository: { mergeQueue: null } } }));
    detectMergeQueue('Wave-Engineering/mcp-server-sdlc');
    expect(execCalls()[0]).toContain('-F owner=Wave-Engineering');
    expect(execCalls()[0]).toContain('-F name=mcp-server-sdlc');
    // owner/name MUST NOT appear inline in the GraphQL query string —
    // the parameterized form is the safe way to pass user-controlled values.
    const queryFragment = execCalls()[0].match(/'query=([^']+)'/)?.[1] ?? '';
    expect(queryFragment).not.toContain('Wave-Engineering');
    expect(queryFragment).not.toContain('mcp-server-sdlc');
  });

  // --- Regression: #258 Bug 3 ---

  test('regression #258: GraphQL query selects __typename, not undefined fields', () => {
    setExecMock(() => JSON.stringify({ data: { repository: { mergeQueue: null } } }));
    detectMergeQueue('Wave-Engineering/mcp-server-sdlc');
    const queryFragment = execCalls()[0].match(/'query=([^']+)'/)?.[1] ?? '';
    // The original bug requested `mergeMethod`, which doesn't exist on
    // GitHub's MergeQueue type and made every query fail with
    // `undefinedField` → silently caching {enabled:false} for every repo.
    expect(queryFragment).not.toContain('mergeMethod');
    // Selection set must contain at least one valid field. __typename is the
    // always-available built-in scalar; any other field would also work but
    // __typename was the chosen replacement.
    expect(queryFragment).toContain('__typename');
  });
});
