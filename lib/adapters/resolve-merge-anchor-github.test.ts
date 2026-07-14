import { describe, test, expect, beforeEach } from 'bun:test';
import {
  installChildProcessMock,
  onExec,
  resetExecMock,
  execCalls,
} from '../test-support/mock-child-process.ts';
import type { AdapterResult, MergeAnchor } from './types.ts';

// Subprocess-boundary tests for the GitHub merge-anchor adapter (#476).
//
// This resolves the FRESHNESS ANCHOR the wave trust gate depends on. Every path
// through it must FAIL CLOSED: if we cannot prove which run belongs to the PR's
// current head, the gate must HOLD rather than grade a run for a stale commit.

installChildProcessMock();

const { resolveMergeAnchorGithub } = await import(
  './resolve-merge-anchor-github.ts'
);

const SHA = 'b'.repeat(40);

function expectErr(r: AdapterResult<MergeAnchor>): asserts r is {
  ok: false;
  code: string;
  error: string;
} {
  if ('ok' in r && r.ok) {
    throw new Error(`expected an ERROR (fail-closed), got ok: ${JSON.stringify(r)}`);
  }
}

beforeEach(() => {
  resetExecMock();
});

describe('resolveMergeAnchorGithub — subprocess boundary (#476)', () => {
  test('reads the PR head SHA via gh pr view --json headRefOid', async () => {
    onExec('gh pr view', JSON.stringify({ headRefOid: SHA }));

    const r = await resolveMergeAnchorGithub({ number: 903, repo: 'org/repo' });
    if (!('ok' in r) || !r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);

    // The PR head SHA — NOT the ephemeral merge commit. A pull_request run
    // reports exactly this in head_sha, which is what makes it a valid anchor.
    expect(r.data.head_sha).toBe(SHA);
    expect(r.data.head_pipeline_id).toBeUndefined(); // GitLab-only field

    const call = execCalls().join(' ');
    expect(call).toContain('headRefOid');
    expect(call).toContain('903');
    expect(call).toContain('org/repo');
  });

  test('lowercases the SHA so the anchor comparison is case-insensitive', async () => {
    onExec('gh pr view', JSON.stringify({ headRefOid: SHA.toUpperCase() }));
    const r = await resolveMergeAnchorGithub({ number: 1, repo: 'org/repo' });
    if (!('ok' in r) || !r.ok) throw new Error('expected ok');
    expect(r.data.head_sha).toBe(SHA);
  });

  test('FAIL CLOSED: a missing head SHA errors — never an empty anchor', async () => {
    // An empty anchor would make matchesAnchor() return false for everything,
    // which HOLDs — but an explicit error tells the operator WHY.
    onExec('gh pr view', JSON.stringify({}));
    const r = await resolveMergeAnchorGithub({ number: 1, repo: 'org/repo' });
    expectErr(r);
    expect(r.code).toBe('no_head_sha');
  });

  test('FAIL CLOSED: a non-SHA headRefOid is rejected', async () => {
    onExec('gh pr view', JSON.stringify({ headRefOid: 'not-a-sha' }));
    const r = await resolveMergeAnchorGithub({ number: 1, repo: 'org/repo' });
    expectErr(r);
    expect(r.code).toBe('no_head_sha');
  });

  test('FAIL CLOSED: unparseable JSON errors', async () => {
    onExec('gh pr view', 'not json at all');
    const r = await resolveMergeAnchorGithub({ number: 1, repo: 'org/repo' });
    expectErr(r);
    expect(r.code).toBe('gh_pr_view_unparseable');
  });

  test('FAIL CLOSED: an invalid PR number is rejected before shelling out', async () => {
    const r = await resolveMergeAnchorGithub({ number: 0, repo: 'org/repo' });
    expectErr(r);
    expect(r.code).toBe('invalid_number');
    expect(execCalls().length).toBe(0);
  });

  test('FAIL CLOSED: an invalid repo slug is rejected before shelling out', async () => {
    const r = await resolveMergeAnchorGithub({ number: 1, repo: 'not a slug!' });
    expectErr(r);
    expect(r.code).toBe('invalid_repo');
    expect(execCalls().length).toBe(0);
  });
});
