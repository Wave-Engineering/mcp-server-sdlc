// Unit tests for `handlers/wave_reconcile` — Category B drift reconciliation
// per Dev Spec §5.4.1. The handler shell gets a happy-path / drift-missing /
// schema-validation smoke; the heavy lifting (set computation, comment
// rendering, dep-violation matrix) is exercised via the `lib/wave-reconcile`
// pure helpers directly — no adapter mocking needed for those cases.
//
// Adapter injection strategy: `reconcile()` accepts a `Deps` parameter so we
// pass a stub `getAdapter` instead of `mock.module('../lib/adapters/...')`
// (which leaks across files per lesson_bun_native_apis.md). Same pattern as
// `wave_reconcile_mrs`.

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import {
  computeDriftSets,
  renderDriftHaltComment,
  hasDrift,
  issueNumberFromBranch,
  parseDepIssueNumber,
  deferredIssueNumbers,
  waveIssues,
  findWave,
  type PlanData,
  type StateData,
} from '../lib/wave-reconcile.ts';
import { reconcile, default as handler, type Deps } from '../handlers/wave_reconcile.ts';

// ---- child_process mock for platform detection (detectPlatform) ------------
let execMockFn: (cmd: string) => string = (cmd: string) => {
  if (cmd.startsWith('git remote')) return 'https://github.com/org/repo.git\n';
  return '';
};
const mockExecSync = mock((cmd: string, _opts?: unknown) => execMockFn(cmd));
mock.module('child_process', () => ({ execSync: mockExecSync }));

// ---- Adapter stub (injection, not module-mocking) -------------------------
interface MockAdapter {
  prListCalls: Array<unknown>;
  prCommentCalls: Array<unknown>;
  prListReturn: unknown;
  prCommentReturn: unknown;
}

function makeDeps(): { deps: Deps; spy: MockAdapter } {
  const spy: MockAdapter = {
    prListCalls: [],
    prCommentCalls: [],
    prListReturn: { ok: true, data: { prs: [] } },
    prCommentReturn: { ok: true, data: { number: 999, comment_id: 42, url: 'https://example/c/42' } },
  };
  const deps: Deps = {
    // Return a typed-any adapter — the handler only calls `prList` and
    // `prComment`. Casting silences the PlatformAdapter surface area check;
    // real behavior is validated by the integration tests running against the
    // full handler signature.
    getAdapter: () => ({
      prList: async (args: unknown) => { spy.prListCalls.push(args); return spy.prListReturn; },
      prComment: async (args: unknown) => { spy.prCommentCalls.push(args); return spy.prCommentReturn; },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any,
  };
  return { deps, spy };
}

let fixtureDir = '';
const ORIGINAL_ENV = process.env.CLAUDE_PROJECT_DIR;

async function setupFixture(plan: object, state: object) {
  fixtureDir = `/tmp/wave-reconcile-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  const dir = `${fixtureDir}/.claude/status`;
  await Bun.write(`${dir}/phases-waves.json`, JSON.stringify(plan));
  await Bun.write(`${dir}/state.json`, JSON.stringify(state));
  process.env.CLAUDE_PROJECT_DIR = fixtureDir;
}

function resetExec() {
  execMockFn = (cmd: string) => {
    if (cmd.startsWith('git remote')) return 'https://github.com/org/repo.git\n';
    return '';
  };
  mockExecSync.mockClear();
}

function restoreEnv() {
  if (ORIGINAL_ENV === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = ORIGINAL_ENV;
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const BASE_PLAN: PlanData = {
  plan_id: 499,
  plan_issue: 'Wave-Engineering/foo#499',
  phases: [
    {
      number: 2,
      name: 'Schema & API Renames',
      waves: [
        {
          id: 'P2W3',
          number: 3,
          issues: [
            { number: 540, depends_on: [] },
            { number: 541, depends_on: [] },
            { number: 542, depends_on: [] },
          ],
        },
      ],
    },
  ],
};

const EMPTY_STATE: StateData = {
  current_wave: 'P2W3',
  waves: { P2W3: { status: 'in_progress' } },
  deferrals: [],
  kahuna_branch: 'kahuna/499-phase-epic-taxonomy',
};

// ---------------------------------------------------------------------------
// Pure helper tests — heavy lifting happens here
// ---------------------------------------------------------------------------

describe('lib/wave-reconcile pure helpers', () => {
  test('issueNumberFromBranch matches feature/ fix/ chore/ doc/ bug/ singular prefixes', () => {
    expect(issueNumberFromBranch('feature/540-do-a-thing')).toBe(540);
    expect(issueNumberFromBranch('fix/541-bug')).toBe(541);
    expect(issueNumberFromBranch('chore/542-cleanup')).toBe(542);
    expect(issueNumberFromBranch('doc/100-update-readme')).toBe(100);
    expect(issueNumberFromBranch('bug/200-crash')).toBe(200);
    expect(issueNumberFromBranch('main')).toBeNull();
    expect(issueNumberFromBranch('docs/foo-no-num')).toBeNull();
    expect(issueNumberFromBranch('feature/540')).toBeNull(); // needs trailing `-`
  });

  test('parseDepIssueNumber handles number, "#N", "owner/repo#N", "N"', () => {
    expect(parseDepIssueNumber(123)).toBe(123);
    expect(parseDepIssueNumber('#456')).toBe(456);
    expect(parseDepIssueNumber('Wave-Engineering/foo#789')).toBe(789);
    expect(parseDepIssueNumber('321')).toBe(321);
    expect(parseDepIssueNumber('gibberish')).toBeNull();
  });

  test('waveIssues prefers issues, falls back to stories', () => {
    expect(waveIssues({ id: 'x', issues: [{ number: 1 }] })).toEqual([{ number: 1 }]);
    expect(waveIssues({ id: 'x', stories: [{ number: 2 }] })).toEqual([{ number: 2 }]);
    expect(waveIssues({ id: 'x' })).toEqual([]);
    expect(waveIssues({ id: 'x', issues: [{ number: 1 }], stories: [{ number: 99 }] }))
      .toEqual([{ number: 1 }]);
  });

  test('deferredIssueNumbers picks accepted deferrals scoped to wave by #N', () => {
    const state: StateData = {
      deferrals: [
        { wave: 'P2W3', description: 'Defer #540 (flaky)', status: 'accepted' },
        { wave: 'P2W3', description: 'Defer #541', status: 'pending' }, // pending filtered
        { wave: 'P2W2', description: 'Defer #542', status: 'accepted' }, // wrong wave
        { wave: 'P2W3', description: 'Two refs #543 and #544', status: 'accepted' },
      ],
    };
    const got = deferredIssueNumbers(state, 'P2W3');
    expect([...got].sort()).toEqual([540, 543, 544]);
  });

  test('findWave walks phases and returns null on miss', () => {
    expect(findWave(BASE_PLAN, 'P2W3')?.id).toBe('P2W3');
    expect(findWave(BASE_PLAN, 'P2W99')).toBeNull();
  });
});

describe('computeDriftSets — drift computation per §5.4.1', () => {
  test('all expected merged → no drift', () => {
    const sets = computeDriftSets({
      expected: [540, 541, 542],
      actual: [540, 541, 542],
      deferred: [],
      issues: [
        { number: 540, depends_on: [] },
        { number: 541, depends_on: [] },
        { number: 542, depends_on: [] },
      ],
      actualMergeOrder: [540, 541, 542],
    });
    expect(sets.missing).toEqual([]);
    expect(sets.unexpected).toEqual([]);
    expect(sets.dependencyViolations).toEqual([]);
    expect(hasDrift(sets)).toBe(false);
  });

  test('missing story fires Missing drift (IT-DRIFT-B-01 shape)', () => {
    const sets = computeDriftSets({
      expected: [540, 541, 542],
      actual: [540, 542],
      deferred: [],
      issues: [
        { number: 540, depends_on: [] },
        { number: 541, depends_on: [] },
        { number: 542, depends_on: [] },
      ],
    });
    expect(sets.missing).toEqual([541]);
    expect(sets.unexpected).toEqual([]);
    expect(hasDrift(sets)).toBe(true);
  });

  test('deferred story excluded from missing', () => {
    const sets = computeDriftSets({
      expected: [540, 541, 542],
      actual: [540, 542],
      deferred: [541],
      issues: [
        { number: 540, depends_on: [] },
        { number: 541, depends_on: [] },
        { number: 542, depends_on: [] },
      ],
    });
    expect(sets.missing).toEqual([]);
    expect(hasDrift(sets)).toBe(false);
  });

  test('unexpected story fires Unexpected drift', () => {
    const sets = computeDriftSets({
      expected: [540, 541],
      actual: [540, 541, 999], // 999 wasn't in the plan
      deferred: [],
      issues: [{ number: 540, depends_on: [] }, { number: 541, depends_on: [] }],
    });
    expect(sets.unexpected).toEqual([999]);
    expect(hasDrift(sets)).toBe(true);
  });

  test('dep violation — B merged before A in same wave (IT-DRIFT-B-02)', () => {
    const sets = computeDriftSets({
      expected: [540, 541],
      actual: [540, 541],
      deferred: [],
      issues: [
        { number: 540, depends_on: [] },
        { number: 541, depends_on: [540] },
      ],
      actualMergeOrder: [541, 540], // B merged FIRST — violation
    });
    expect(sets.dependencyViolations).toEqual([{ issue: 541, unmet: [540] }]);
    expect(hasDrift(sets)).toBe(true);
  });

  test('dep satisfied — A merged before B in same wave', () => {
    const sets = computeDriftSets({
      expected: [540, 541],
      actual: [540, 541],
      deferred: [],
      issues: [
        { number: 540, depends_on: [] },
        { number: 541, depends_on: [540] },
      ],
      actualMergeOrder: [540, 541],
    });
    expect(sets.dependencyViolations).toEqual([]);
    expect(hasDrift(sets)).toBe(false);
  });

  test('dep satisfied by previouslyMerged', () => {
    const sets = computeDriftSets({
      expected: [541],
      actual: [541],
      deferred: [],
      previouslyMerged: [540],
      issues: [{ number: 541, depends_on: [540] }],
      actualMergeOrder: [541],
    });
    expect(sets.dependencyViolations).toEqual([]);
  });

  test('dep unmet — dep was never merged anywhere', () => {
    const sets = computeDriftSets({
      expected: [541],
      actual: [541],
      deferred: [],
      issues: [{ number: 541, depends_on: [540] }],
      actualMergeOrder: [541],
    });
    expect(sets.dependencyViolations).toEqual([{ issue: 541, unmet: [540] }]);
  });

  test('foundation-wave issues skipped from dep check', () => {
    const sets = computeDriftSets({
      expected: [100],
      actual: [100],
      deferred: [],
      foundationWaveIssues: [100],
      issues: [{ number: 100, depends_on: [999] }],
      actualMergeOrder: [100],
    });
    expect(sets.dependencyViolations).toEqual([]);
  });

  test('issue without depends_on is skipped (absence = conservative)', () => {
    const sets = computeDriftSets({
      expected: [540],
      actual: [540],
      deferred: [],
      issues: [{ number: 540 }],
      actualMergeOrder: [540],
    });
    expect(sets.dependencyViolations).toEqual([]);
  });
});

describe('renderDriftHaltComment — canonical §5.4.1 body shape', () => {
  const sets = computeDriftSets({
    expected: [540, 541, 542],
    actual: [540, 542],
    deferred: [],
    issues: [
      { number: 540, depends_on: [] },
      { number: 541, depends_on: [] },
      { number: 542, depends_on: [] },
    ],
  });

  test('renders the canonical worked-example shape verbatim', () => {
    const body = renderDriftHaltComment({
      timestamp: '2026-04-27T14:55Z',
      waveId: 'P2W3',
      plan: BASE_PLAN,
      sets,
    });
    expect(body).toContain('[drift-halt] 2026-04-27T14:55Z · /wavemachine wave-3');
    expect(body).toContain('**Category:** B — Story count / dependency violation');
    expect(body).toContain('**Wave:** Phase 2 Wave 3');
    expect(body).toContain('**Expected stories:** #540 #541 #542');
    expect(body).toContain('**Actual merged:** #540 #542');
    expect(body).toContain('**Missing:** #541');
    expect(body).toContain('**Unexpected:** (none)');
    expect(body).toContain('**Dependency violations:** (none)');
    expect(body).toContain('**Deferrals recorded:** (none)');
    expect(body).toContain('**Next step:**');
  });

  test('dep violations rendered with `depends on` suffix', () => {
    const depSets = computeDriftSets({
      expected: [540, 541],
      actual: [540, 541],
      deferred: [],
      issues: [
        { number: 540, depends_on: [] },
        { number: 541, depends_on: [540] },
      ],
      actualMergeOrder: [541, 540],
    });
    const body = renderDriftHaltComment({
      timestamp: '2026-04-27T14:55Z',
      waveId: 'P2W3',
      plan: BASE_PLAN,
      sets: depSets,
    });
    expect(body).toContain('**Dependency violations:** #541 (depends on #540)');
  });

  test('falls back to waveId when phase/wave numbers missing', () => {
    const planNoNums: PlanData = {
      phases: [{ waves: [{ id: 'P9W9', issues: [{ number: 1 }] }] }],
    };
    const body = renderDriftHaltComment({
      timestamp: '2026-04-27T00:00Z',
      waveId: 'P9W9',
      plan: planNoNums,
      sets,
    });
    expect(body).toContain('[drift-halt] 2026-04-27T00:00Z · /wavemachine P9W9');
    expect(body).toContain('**Wave:** P9W9');
  });
});

// ---------------------------------------------------------------------------
// Handler-shell tests — verify the HandlerDef envelope + orchestration.
// ---------------------------------------------------------------------------

describe('wave_reconcile handler shell', () => {
  beforeEach(resetExec);
  afterEach(restoreEnv);

  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('wave_reconcile');
    expect(typeof handler.description).toBe('string');
    expect(handler.description.length).toBeGreaterThan(0);
    expect(typeof handler.execute).toBe('function');
  });

  test('happy path — all expected merged, no drift, no comment posted', async () => {
    await setupFixture(BASE_PLAN, EMPTY_STATE);
    const { deps, spy } = makeDeps();
    spy.prListReturn = {
      ok: true,
      data: {
        prs: [
          { number: 1, title: 't', state: 'merged', head: 'feature/540-a', base: 'kahuna/499-x', url: 'u1' },
          { number: 2, title: 't', state: 'merged', head: 'feature/541-b', base: 'kahuna/499-x', url: 'u2' },
          { number: 3, title: 't', state: 'merged', head: 'feature/542-c', base: 'kahuna/499-x', url: 'u3' },
        ],
      },
    };
    const result = await reconcile({ wave_id: 'P2W3' }, deps);
    expect(result.ok).toBe(true);
    expect(result.drift).toBe(false);
    expect((result.sets as { missing: number[] }).missing).toEqual([]);
    expect(spy.prCommentCalls.length).toBe(0);
  });

  test('IT-DRIFT-B-01 shape — 3 stories expected, 2 merge, Missing drift posted', async () => {
    await setupFixture(BASE_PLAN, EMPTY_STATE);
    const { deps, spy } = makeDeps();
    spy.prListReturn = {
      ok: true,
      data: {
        prs: [
          { number: 1, title: 't', state: 'merged', head: 'feature/540-a', base: 'kahuna/499-x', url: 'u1' },
          { number: 3, title: 't', state: 'merged', head: 'feature/542-c', base: 'kahuna/499-x', url: 'u3' },
        ],
      },
    };
    const result = await reconcile({ wave_id: 'P2W3', timestamp: '2026-04-27T14:55Z' }, deps);
    expect(result.ok).toBe(true);
    expect(result.drift).toBe(true);
    expect((result.sets as { missing: number[] }).missing).toEqual([541]);
    expect(result.plan_issue_number).toBe(499);
    expect(spy.prCommentCalls.length).toBe(1);
    const callArgs = spy.prCommentCalls[0] as { number: number; body: string };
    expect(callArgs.number).toBe(499);
    expect(callArgs.body).toContain('[drift-halt] 2026-04-27T14:55Z');
    expect(callArgs.body).toContain('**Category:** B');
    expect(callArgs.body).toContain('**Missing:** #541');
  });

  test('dry_run — computes drift but does NOT post comment', async () => {
    await setupFixture(BASE_PLAN, EMPTY_STATE);
    const { deps, spy } = makeDeps();
    spy.prListReturn = {
      ok: true,
      data: {
        prs: [
          { number: 1, title: 't', state: 'merged', head: 'feature/540-a', base: 'kahuna/499-x', url: 'u1' },
        ],
      },
    };
    const result = await reconcile({ wave_id: 'P2W3', dry_run: true, timestamp: '2026-04-27T14:55Z' }, deps);
    expect(result.ok).toBe(true);
    expect(result.drift).toBe(true);
    expect(result.dry_run).toBe(true);
    expect((result.comment_body as string)).toContain('[drift-halt]');
    expect(spy.prCommentCalls.length).toBe(0);
  });

  test('deferred story excluded from Missing — no drift, no comment', async () => {
    const state: StateData = {
      ...EMPTY_STATE,
      deferrals: [{ wave: 'P2W3', description: 'Defer #541 — flaky', status: 'accepted' }],
    };
    await setupFixture(BASE_PLAN, state);
    const { deps, spy } = makeDeps();
    spy.prListReturn = {
      ok: true,
      data: {
        prs: [
          { number: 1, title: 't', state: 'merged', head: 'feature/540-a', base: 'kahuna/499-x', url: 'u1' },
          { number: 3, title: 't', state: 'merged', head: 'feature/542-c', base: 'kahuna/499-x', url: 'u3' },
        ],
      },
    };
    const result = await reconcile({ wave_id: 'P2W3' }, deps);
    expect(result.ok).toBe(true);
    expect(result.drift).toBe(false);
    expect((result.sets as { deferred: number[] }).deferred).toEqual([541]);
    expect(spy.prCommentCalls.length).toBe(0);
  });

  test('missing state files — returns structured error', async () => {
    fixtureDir = `/tmp/wave-reconcile-empty-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    process.env.CLAUDE_PROJECT_DIR = fixtureDir;
    const { deps } = makeDeps();
    const result = await reconcile({ wave_id: 'P2W3' }, deps);
    expect(result.ok).toBe(false);
    expect((result.error as string)).toContain('state files not found');
  });

  test('wave_id defaults to state.current_wave', async () => {
    await setupFixture(BASE_PLAN, EMPTY_STATE);
    const { deps, spy } = makeDeps();
    spy.prListReturn = { ok: true, data: { prs: [] } };
    const result = await reconcile({}, deps);
    expect(result.wave_id).toBe('P2W3');
  });

  test('no current wave + no wave_id → error', async () => {
    await setupFixture(BASE_PLAN, { current_wave: null, waves: {}, deferrals: [] });
    const { deps } = makeDeps();
    const result = await reconcile({}, deps);
    expect(result.ok).toBe(false);
    expect((result.error as string)).toContain('no wave_id provided');
  });

  test('unknown wave_id → error', async () => {
    await setupFixture(BASE_PLAN, EMPTY_STATE);
    const { deps } = makeDeps();
    const result = await reconcile({ wave_id: 'P9W9' }, deps);
    expect(result.ok).toBe(false);
    expect((result.error as string)).toContain("wave 'P9W9' not found");
  });

  test('schema_validation — rejects unknown fields', async () => {
    const { deps } = makeDeps();
    const result = await reconcile({ wave_id: 'P2W3', bogus: 1 }, deps);
    expect(result.ok).toBe(false);
  });

  test('pr_list platform_unsupported surfaces with ok:true', async () => {
    await setupFixture(BASE_PLAN, EMPTY_STATE);
    const { deps, spy } = makeDeps();
    spy.prListReturn = { platform_unsupported: true, hint: 'test' };
    const result = await reconcile({ wave_id: 'P2W3' }, deps);
    expect(result.ok).toBe(true);
    expect(result.platform_unsupported).toBe(true);
  });

  test('pr_list failure → ok:false with error', async () => {
    await setupFixture(BASE_PLAN, EMPTY_STATE);
    const { deps, spy } = makeDeps();
    spy.prListReturn = { ok: false, error: 'rate limited', code: 'gh_pr_list_failed' };
    const result = await reconcile({ wave_id: 'P2W3' }, deps);
    expect(result.ok).toBe(false);
    expect((result.error as string)).toContain('rate limited');
  });

  test('drift detected but no plan_issue_number derivable → ok:false', async () => {
    const planNoIssue: PlanData = { phases: BASE_PLAN.phases };
    await setupFixture(planNoIssue, EMPTY_STATE);
    const { deps, spy } = makeDeps();
    spy.prListReturn = { ok: true, data: { prs: [] } };
    const result = await reconcile({ wave_id: 'P2W3' }, deps);
    expect(result.ok).toBe(false);
    expect((result.error as string)).toContain('no plan_issue_number');
    expect(result.drift).toBe(true);
  });

  test('plan_issue_number override takes precedence over plan.plan_id', async () => {
    await setupFixture(BASE_PLAN, EMPTY_STATE);
    const { deps, spy } = makeDeps();
    spy.prListReturn = { ok: true, data: { prs: [] } }; // nothing merged → drift
    const result = await reconcile({ wave_id: 'P2W3', plan_issue_number: 123, timestamp: '2026-04-27T14:55Z' }, deps);
    expect(result.ok).toBe(true);
    expect(result.drift).toBe(true);
    expect(result.plan_issue_number).toBe(123);
    expect(spy.prCommentCalls.length).toBe(1);
    expect((spy.prCommentCalls[0] as { number: number }).number).toBe(123);
  });

  test('handler.execute returns MCP envelope', async () => {
    // Smoke: the handler's execute wraps reconcile in the MCP content envelope
    // and uses the default adapter. We verify the envelope shape but accept
    // that the default getAdapter may fail without a real git remote — we
    // just need the parse / ok:false path, which still returns the envelope.
    const result = await handler.execute({ wave_id: 'P2W3', bogus: 1 });
    expect(result.content).toBeArray();
    expect(result.content[0].type).toBe('text');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
  });
});
