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

describe('resolveMergeAnchorGitlab — subprocess boundary (#476)', () => {
  test('reads head_pipeline.id from the MR', async () => {
    onExec(
      'glab api',
      JSON.stringify({ iid: 108, head_pipeline: { id: 500, status: 'success' } }),
    );

    const r = await resolveMergeAnchorGitlab({ number: 108, repo: 'org/repo' });
    if (!('ok' in r) || !r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);

    expect(r.data.head_pipeline_id).toBe(500);
    expect(r.data.head_sha).toBeUndefined(); // GitHub-only field
  });

  test('falls back to `pipeline` when `head_pipeline` is absent', async () => {
    onExec('glab api', JSON.stringify({ iid: 108, pipeline: { id: 501 } }));
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
    // resolve `analogicdev/internal` instead of the real project — and route.ts
    // sends exactly these deep slugs to the GitLab adapter (#290).
    onExec('glab api', JSON.stringify({ iid: 4, head_pipeline: { id: 77 } }));

    const r = await resolveMergeAnchorGitlab({
      number: 4,
      repo: 'analogicdev/internal/tools/waldorf',
    });
    if (!('ok' in r) || !r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
    expect(r.data.head_pipeline_id).toBe(77);

    const call = execCalls().join(' ');
    // The full path, URL-encoded — not the truncated `analogicdev/internal`.
    expect(call).toContain('analogicdev%2Finternal%2Ftools%2Fwaldorf');
  });
});
