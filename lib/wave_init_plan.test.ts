import { describe, test, expect } from 'bun:test';
import { bootstrapKahunaBranchRemote, kahunaBranchName, normalizePlanJson } from './wave_init_plan.ts';

describe('normalizePlanJson', () => {
  test('transforms devspec-upshift shape to wave-status shape', () => {
    const upshift = JSON.stringify({
      plan_id: 2,
      slug: 'org/repo',
      phases: [{
        name: 'Phase 1: Foundation',
        dod: ['deliverable'],
        waves: [{
          name: 'P1W1',
          stories: [
            { id: '1.1', issue: 501, title: 'Story A', depends_on: [] },
            { id: '1.2', issue: 502, title: 'Story B', depends_on: ['1.1'] },
          ],
        }],
      }],
    });

    const result = JSON.parse(normalizePlanJson(upshift));
    expect(result.project).toBe('org/repo');
    expect(result.phases[0].waves[0].id).toBe('P1W1');
    expect(result.phases[0].waves[0].stories).toBeUndefined();
    expect(result.phases[0].waves[0].name).toBeUndefined();
    expect(result.phases[0].waves[0].issues).toHaveLength(2);
    expect(result.phases[0].waves[0].issues[0]).toEqual({
      number: 501,
      repo: 'org/repo',
      ref: 'org/repo#501',
      title: 'Story A',
      depends_on: [],
    });
  });

  test('passes through already-correct wave-status shape', () => {
    const correct = JSON.stringify({
      project: 'org/repo',
      phases: [{
        waves: [{
          id: 'P1W1',
          issues: [{ number: 501, repo: 'org/repo', ref: 'org/repo#501' }],
        }],
      }],
    });

    expect(normalizePlanJson(correct)).toBe(correct);
  });

  test('uses repoSlug param when plan has no slug/project', () => {
    const upshift = JSON.stringify({
      plan_id: 2,
      phases: [{
        waves: [{
          name: 'P1W1',
          stories: [{ id: '1.1', issue: 10, title: 'Story', depends_on: [] }],
        }],
      }],
    });

    const result = JSON.parse(normalizePlanJson(upshift, 'team/project'));
    expect(result.project).toBe('team/project');
    expect(result.phases[0].waves[0].issues[0].repo).toBe('team/project');
    expect(result.phases[0].waves[0].issues[0].ref).toBe('team/project#10');
  });

  test('preserves multi-phase structure', () => {
    const upshift = JSON.stringify({
      plan_id: 5,
      slug: 'org/repo',
      phases: [
        { name: 'Phase 1', waves: [{ name: 'P1W1', stories: [{ id: '1.1', issue: 1, title: 'A', depends_on: [] }] }] },
        { name: 'Phase 2', waves: [{ name: 'P2W1', stories: [{ id: '2.1', issue: 2, title: 'B', depends_on: [] }] }] },
      ],
    });

    const result = JSON.parse(normalizePlanJson(upshift));
    expect(result.phases).toHaveLength(2);
    expect(result.phases[0].waves[0].id).toBe('P1W1');
    expect(result.phases[1].waves[0].id).toBe('P2W1');
  });

  test('returns original on invalid JSON', () => {
    expect(normalizePlanJson('not-json')).toBe('not-json');
  });

  test('returns original when phases is empty', () => {
    const empty = JSON.stringify({ phases: [] });
    expect(normalizePlanJson(empty)).toBe(empty);
  });

  test('cross-repo stories preserve their own repo field', () => {
    const upshift = JSON.stringify({
      plan_id: 2,
      slug: 'org/main-repo',
      phases: [{
        waves: [{
          name: 'P1W1',
          stories: [
            { id: '1.1', issue: 10, title: 'local', depends_on: [], repo: 'org/main-repo' },
            { id: '1.2', issue: 19, title: 'cross', depends_on: [], repo: 'org/other-repo' },
          ],
        }],
      }],
    });

    const result = JSON.parse(normalizePlanJson(upshift));
    expect(result.phases[0].waves[0].issues[1].repo).toBe('org/other-repo');
    expect(result.phases[0].waves[0].issues[1].ref).toBe('org/other-repo#19');
  });
});

// ---------------------------------------------------------------------------
// #503 — the integration branch name comes from the CALLER
// ---------------------------------------------------------------------------
// The bootstrap takes all of its platform contact through injected deps, so these
// exercise the real function with no exec mocking. The load-bearing assertion in
// every "rejected" case is `created: []` — that the branch was never CUT, not
// merely that an error came back.

const SHA = 'a'.repeat(40);

/** A deps double that records every branch it was asked to create. */
function fakeDeps(opts: { onRemote?: string[] } = {}) {
  const created: string[] = [];
  const onRemote = new Set(opts.onRemote ?? []);
  return {
    created,
    deps: {
      slug: 'o/r',
      branchPresentOnRemote: (b: string) => onRemote.has(b),
      adapter: {
        resolveBranchSha: async () => ({ ok: true as const, data: { sha: SHA } }),
        createBranch: async ({ branch }: { branch: string }) => {
          created.push(branch);
          onRemote.add(branch);
          return { ok: true as const, data: {} };
        },
      },
    } as unknown as Parameters<typeof bootstrapKahunaBranchRemote>[4],
  };
}

const noState = async () => ({ kahuna_branch: null });

describe('kahunaBranchName (#503)', () => {
  test('derives the historical name when no branch is supplied', () => {
    const r = kahunaBranchName({ plan_id: 56, slug: 'blueshift' });
    expect(r).toEqual({ ok: true, branch: 'kahuna/56-blueshift' });
  });

  test('returns an explicit branch verbatim — no re-derivation, no normalization', () => {
    const r = kahunaBranchName({ plan_id: 56, slug: 'blueshift', branch: 'kahuna/56-W-2' });
    expect(r).toEqual({ ok: true, branch: 'kahuna/56-W-2' });
  });

  test.each([
    ['ends with .lock', 'kahuna/56-w.lock'],
    ['has a leading dash', '-kahuna/56-w'],
    ['is fully qualified', 'refs/heads/kahuna/56-w'],
    ['contains ..', 'kahuna/56../w'],
    ['contains a space', 'kahuna/56 w'],
    ['has an empty path component', 'kahuna//56-w'],
    ['contains a glob char', 'kahuna/56-w*'],
    ['contains @{', 'kahuna/56-w@{1}'],
  ])('rejects a branch that %s', (_why, branch) => {
    const r = kahunaBranchName({ plan_id: 56, slug: 'blueshift', branch });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('not a valid git ref');
  });
});

describe('bootstrapKahunaBranchRemote branch naming (#503)', () => {
  test('an explicit branch is the ref created — the derived name is not', async () => {
    const { created, deps } = fakeDeps();
    const r = await bootstrapKahunaBranchRemote(
      '/tmp', { plan_id: 56, slug: 'blueshift', branch: 'kahuna/56-W-2' },
      'campaign/56-blueshift', noState, deps, 'main',
    );
    expect(r).toMatchObject({ ok: true, kahuna_branch: 'kahuna/56-W-2', created: true });
    expect(created).toEqual(['kahuna/56-W-2']);
    expect(created).not.toContain('kahuna/56-blueshift');
  });

  test('omitting branch keeps the derived kahuna/<plan_id>-<slug>', async () => {
    const { created, deps } = fakeDeps();
    const r = await bootstrapKahunaBranchRemote(
      '/tmp', { plan_id: 56, slug: 'blueshift' }, 'main', noState, deps, 'main',
    );
    expect(r).toMatchObject({ ok: true, kahuna_branch: 'kahuna/56-blueshift', created: true });
    expect(created).toEqual(['kahuna/56-blueshift']);
  });

  test('a branch equal to the BASE is rejected and never created', async () => {
    const { created, deps } = fakeDeps();
    const r = await bootstrapKahunaBranchRemote(
      '/tmp', { plan_id: 56, slug: 'blueshift', branch: 'campaign/56-blueshift' },
      'campaign/56-blueshift', noState, deps, 'main',
    );
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('same ref as the base branch');
    expect(created).toEqual([]);
  });

  // The dangerous one: trunk already EXISTS on the remote, so without this guard
  // the reuse path claims the protected branch itself as the integration branch and
  // every flight merges straight to it (claudecode-workflow#1052).
  test('a branch equal to the REPO DEFAULT is rejected even though the base differs', async () => {
    const { created, deps } = fakeDeps({ onRemote: ['main'] });
    const r = await bootstrapKahunaBranchRemote(
      '/tmp', { plan_id: 56, slug: 'blueshift', branch: 'main' },
      'campaign/56-blueshift', noState, deps, 'main',
    );
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('same ref as the repo default branch');
    expect(created).toEqual([]);
  });

  test('an invalid ref is rejected before any platform call', async () => {
    const { created, deps } = fakeDeps();
    const r = await bootstrapKahunaBranchRemote(
      '/tmp', { plan_id: 56, slug: 'blueshift', branch: 'kahuna/56 W2' },
      'campaign/56-blueshift', noState, deps, 'main',
    );
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('not a valid git ref');
    expect(created).toEqual([]);
  });

  // Per-wave branches accumulate across a campaign: the wave-2 bootstrap must reuse
  // its own branch when a retry finds it, not error as a cross-plan orphan.
  test('an existing explicit branch is claimed as reuse, not re-cut', async () => {
    const { created, deps } = fakeDeps({ onRemote: ['kahuna/56-W-2'] });
    const r = await bootstrapKahunaBranchRemote(
      '/tmp', { plan_id: 56, slug: 'blueshift', branch: 'kahuna/56-W-2' },
      'campaign/56-blueshift', noState, deps, 'main',
    );
    expect(r).toMatchObject({ ok: true, kahuna_branch: 'kahuna/56-W-2', created: false, previously_recorded: false });
    expect(created).toEqual([]);
  });
});
