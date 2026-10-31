import { describe, test, expect, beforeEach } from 'bun:test';
import {
  installChildProcessMock,
  onExec,
  resetExecMock,
  execCalls,
} from '../test-support/mock-child-process.ts';
import type { AdapterResult, MergeAnchor } from './types.ts';

// Subprocess-boundary tests for the GitLab merge-anchor adapter (#476).
//
// A merged-results pipeline runs against the EPHEMERAL MERGE COMMIT, so its sha
// can never equal the branch HEAD — a SHA match is impossible by construction.
// GitLab's `head_pipeline` is its own statement of which pipeline is current for
// the MR head, and that id IS the anchor. Every failure path must FAIL CLOSED.

installChildProcessMock();

const { resolveMergeAnchorGitlab } = await import(
  './resolve-merge-anchor-gitlab.ts'
);

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
  onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git');
});

const HEAD = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';

describe('resolveMergeAnchorGitlab — subprocess boundary (#476)', () => {
  test('reads head_pipeline.id from the MR', async () => {
    onExec(
      'glab api',
      JSON.stringify({
        iid: 108,
        sha: HEAD,
        head_pipeline: { id: 500, status: 'success', sha: HEAD, ref: 'feature/x' },
      }),
    );

    const r = await resolveMergeAnchorGitlab({ number: 108, repo: 'org/repo' });
    if (!('ok' in r) || !r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);

    expect(r.data.head_pipeline_id).toBe(500);
    // #588: the head the pipeline is bound to, for the pre-grade re-check.
    expect(r.data.head_sha).toBe(HEAD);
  });

  test('falls back to `pipeline` when `head_pipeline` is absent', async () => {
    onExec('glab api', JSON.stringify({ iid: 108, sha: HEAD, pipeline: { id: 501, sha: HEAD, ref: 'feature/x' } }));
    const r = await resolveMergeAnchorGitlab({ number: 108, repo: 'org/repo' });
    if (!('ok' in r) || !r.ok) throw new Error('expected ok');
    expect(r.data.head_pipeline_id).toBe(501);
  });

  test('FAIL CLOSED: no head_pipeline → error naming the likely CI misconfig', async () => {
    // GitLab associates no pipeline with the MR head. Commonly: merged-results
    // pipelines disabled, or .gitlab-ci.yml admits no merge-request pipelines.
    // Either way we cannot prove freshness, so we must not grade anything.
    onExec('glab api', JSON.stringify({ iid: 108 }));
    const r = await resolveMergeAnchorGitlab({ number: 108, repo: 'org/repo' });
    expectErr(r);
    expect(r.code).toBe('no_head_pipeline');
    expect(r.error).toMatch(/merge_pipelines_enabled/);
  });

  test('FAIL CLOSED: an invalid MR iid is rejected before shelling out', async () => {
    const r = await resolveMergeAnchorGitlab({ number: -1, repo: 'org/repo' });
    expectErr(r);
    expect(r.code).toBe('invalid_number');
    expect(execCalls().length).toBe(0);
  });

  test('NESTED GROUPS: a 3+-segment slug resolves the FULL project path', async () => {
    // GitLab supports arbitrarily-nested groups. A 2-way split on '/' would
    // resolve `example-group/internal` instead of the real project — and route.ts
    // sends exactly these deep slugs to the GitLab adapter (#290).
    onExec('glab api', JSON.stringify({ iid: 4, sha: HEAD, head_pipeline: { id: 77, sha: HEAD, ref: 'feature/x' } }));

    const r = await resolveMergeAnchorGitlab({
      number: 4,
      repo: 'example-group/internal/tools/waldorf',
    });
    if (!('ok' in r) || !r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
    expect(r.data.head_pipeline_id).toBe(77);

    const call = execCalls().join(' ');
    // The full path, URL-encoded — not the truncated `example-group/internal`.
    expect(call).toContain('example-group%2Finternal%2Ftools%2Fwaldorf');
  });
});

// #588: right after a push GitLab can still name the PREVIOUS head's merge-result
// pipeline as `head_pipeline`. Anchoring on it lets that head's green run pass
// ci_wait_run(require_merge_result). The anchor must refuse until it is bound.
describe('resolveMergeAnchorGitlab — head_pipeline must be bound to the head (#588)', () => {
  const OLD = 'b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0';
  const NEW = 'c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1';
  const BASE = 'd2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2';
  const MERGE_OLD = 'e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3';
  const MERGE_NEW = 'f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4';
  const REF = 'refs/merge-requests/108/merge';
  const parentsOf = (sha: string) =>
    ({ [MERGE_OLD]: [BASE, OLD], [MERGE_NEW]: [BASE, NEW] })[sha];

  function mr(pipeline: Record<string, unknown>) {
    return JSON.stringify({ iid: 108, sha: NEW, head_pipeline: pipeline });
  }

  test('RED: push then an immediate wait — the old head merge pipeline is refused, named', async () => {
    onExec('glab api', mr({ id: 500, status: 'success', sha: MERGE_OLD, ref: REF }));
    const r = await resolveMergeAnchorGitlab({ number: 108, repo: 'org/repo' }, parentsOf);
    expectErr(r);
    expect(r.code).toBe('head_pipeline_not_bound');
    expect(r.error).toContain('head_pipeline 500');
    expect(r.error).toContain('not attached yet');
  });

  test('GREEN: once the head merge pipeline is attached, it is the anchor', async () => {
    onExec('glab api', mr({ id: 600, status: 'running', sha: MERGE_NEW, ref: REF }));
    const r = await resolveMergeAnchorGitlab({ number: 108, repo: 'org/repo' }, parentsOf);
    if (!('ok' in r) || !r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
    expect(r.data).toEqual({ head_pipeline_id: 600, head_sha: NEW });
  });

  test('a branch pipeline on the previous head is refused too', async () => {
    onExec('glab api', mr({ id: 501, status: 'success', sha: OLD, ref: 'feature/x' }));
    const r = await resolveMergeAnchorGitlab({ number: 108, repo: 'org/repo' }, parentsOf);
    expectErr(r);
    expect(r.code).toBe('head_pipeline_not_bound');
  });

  test('FAIL CLOSED: an unreadable merge commit is refused', async () => {
    onExec('glab api', mr({ id: 600, status: 'success', sha: MERGE_NEW, ref: REF }));
    const r = await resolveMergeAnchorGitlab({ number: 108, repo: 'org/repo' }, () => undefined);
    expectErr(r);
    expect(r.code).toBe('head_pipeline_not_bound');
    expect(r.error).toContain('could not read merge commit');
  });

  // The gate itself: ci_wait_run(require_merge_result) with the REAL GitLab anchor.
  // The run list already holds the previous head's GREEN merge-result pipeline.
  function mergeRun(id: number, sha: string, conclusion: 'success' | 'failed') {
    return {
      run_id: id,
      workflow_name: 'merge_request_event',
      status: conclusion,
      conclusion,
      url: `https://gitlab.com/org/repo/-/pipelines/${id}`,
      head_sha: sha,
      head_branch: REF,
      created_at: '2026-10-31T10:00:00Z',
      event: 'merge_request_event',
    };
  }
  // The previous head's GREEN merge-result pipeline, already in the run list.
  const oldGreen = mergeRun(500, MERGE_OLD, 'success');
  const stale = JSON.stringify({ iid: 108, sha: NEW, head_pipeline: { id: 500, status: 'success', sha: MERGE_OLD, ref: REF } });

  /** Each anchor read returns the next MR state, then repeats the last. */
  async function gate(mrStates: string[], runs: object[], timeoutSec = 60) {
    const { waitForRun } = await import('../ci-wait-run-poll.ts');
    let i = 0;
    onExec('glab api', () => mrStates[Math.min(i++, mrStates.length - 1)]);
    let t = 1_700_000_000_000;
    const start = t;
    const r = await waitForRun(
      { ref: REF, platform: 'gitlab', require_merge_result: true, pr_number: 108, repo: 'org/repo', timeout_sec: timeoutSec },
      {
        adapter: {
          ciListRuns: async () => ({ ok: true as const, data: runs as never }),
          resolveBranchSha: async () => ({ ok: true as const, data: null }),
          resolveMergeAnchor: (a) => resolveMergeAnchorGitlab(a, parentsOf),
        },
        sleep: async (ms: number) => {
          t += ms;
        },
        now: () => t,
      },
    );
    return { r, waitedSec: (t - start) / 1000 };
  }

  test('RED (gate): push then an immediate wait HOLDS past the old green and grades the new head run', async () => {
    // The head's merge pipeline attaches on the third read, and it FAILED. If the
    // old green were graded, this would read success.
    const bound = JSON.stringify({ iid: 108, sha: NEW, head_pipeline: { id: 600, status: 'failed', sha: MERGE_NEW, ref: REF } });
    const { r, waitedSec } = await gate([stale, stale, bound], [oldGreen, mergeRun(600, MERGE_NEW, 'failed')]);
    expect(r.final_status).toBe('failure');
    expect(r.run_id).toBe(600);
    expect(waitedSec).toBeGreaterThan(0);
  });

  test('RED (gate): a head pipeline that never attaches fails closed, naming why', async () => {
    const { r, waitedSec } = await gate([stale], [oldGreen]);
    expect(r.ok).toBe(false);
    expect(r.final_status).toBe('not_merge_result');
    if (!r.ok) expect(r.error).toContain('not attached yet');
    expect(waitedSec).toBeGreaterThanOrEqual(60);
  });

  test('a refusal other than not-bound still fails at once (no head_pipeline)', async () => {
    const { r, waitedSec } = await gate([JSON.stringify({ iid: 108, sha: NEW })], [oldGreen]);
    expect(r.final_status).toBe('not_merge_result');
    expect(waitedSec).toBe(0);
  });

  test('GREEN (gate): the same pipeline passes when it IS the current head pipeline', async () => {
    // Same run list, but the MR head is the commit that pipeline merged: bound.
    const current = JSON.stringify({ iid: 108, sha: OLD, head_pipeline: { id: 500, status: 'success', sha: MERGE_OLD, ref: REF } });
    const { r, waitedSec } = await gate([current], [oldGreen]);
    expect(r.ok).toBe(true);
    expect(r.final_status).toBe('success');
    expect(r.run_id).toBe(500);
    // Already green and bound: no hold.
    expect(waitedSec).toBe(0);
  });

  test('FAIL CLOSED: an MR with no head SHA is refused', async () => {
    onExec('glab api', JSON.stringify({ iid: 108, head_pipeline: { id: 500, sha: OLD, ref: REF } }));
    const r = await resolveMergeAnchorGitlab({ number: 108, repo: 'org/repo' }, parentsOf);
    expectErr(r);
    expect(r.code).toBe('head_pipeline_not_bound');
  });
});
