// Integration tests for `handlers/wave_reconcile` per Dev Spec §5.4.4:
//
//   IT-DRIFT-B-01 — 3 stories in a wave, only 2 merge → `[drift-halt]`
//                   Category B posted with `Missing: #<third>`.
//   IT-DRIFT-B-02 — Story B declares `depends_on: [A]` but B merges first
//                   in the wave → dependency-violation drift fires.
//
// These tests drive the full `reconcile()` entry point (schema → statusDir
// read → pr_list → computeDriftSets → renderDriftHaltComment → pr_comment).
// The platform adapter is injected via the `Deps` seam so no `mock.module`
// leakage hits sibling adapter tests (lesson_bun_native_apis.md).

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { reconcile, type Deps } from '../handlers/wave_reconcile.ts';

let execMockFn: (cmd: string) => string = (cmd: string) => {
  if (cmd.startsWith('git remote')) return 'https://github.com/org/repo.git\n';
  return '';
};
const mockExecSync = mock((cmd: string, _opts?: unknown) => execMockFn(cmd));
mock.module('child_process', () => ({ execSync: mockExecSync }));

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
    prCommentReturn: { ok: true, data: { number: 499, comment_id: 7777, url: 'https://example/c/7777' } },
  };
  const deps: Deps = {
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
  fixtureDir = `/tmp/wave-reconcile-it-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
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
// IT-DRIFT-B-01
// ---------------------------------------------------------------------------

describe('IT-DRIFT-B-01 — Missing story fires Category B drift', () => {
  beforeEach(resetExec);
  afterEach(restoreEnv);

  test('Plan with 3 stories; only 2 merge → [drift-halt] posted with Missing: #<third>', async () => {
    const plan = {
      plan_id: 499,
      plan_issue: 'Wave-Engineering/claudecode-workflow#499',
      phases: [
        {
          number: 2,
          name: 'Schema & API Renames',
          waves: [
            {
              id: 'P2W5',
              number: 5,
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
    const state = {
      current_wave: 'P2W5',
      waves: { P2W5: { status: 'in_progress' } },
      deferrals: [],
      kahuna_branch: 'kahuna/499-phase-epic-taxonomy',
    };
    await setupFixture(plan, state);

    const { deps, spy } = makeDeps();
    spy.prListReturn = {
      ok: true,
      data: {
        prs: [
          { number: 100, title: 't', state: 'merged', head: 'feature/540-a', base: 'kahuna/499-x', url: 'u1' },
          { number: 102, title: 't', state: 'merged', head: 'feature/542-c', base: 'kahuna/499-x', url: 'u3' },
          // #541 didn't merge
        ],
      },
    };

    const result = await reconcile({
      wave_id: 'P2W5',
      timestamp: '2026-04-27T14:55Z',
    }, deps);

    // --- Assertions ---------------------------------------------------
    expect(result.ok).toBe(true);
    expect(result.drift).toBe(true);
    expect((result.sets as { missing: number[] }).missing).toEqual([541]);
    expect(result.plan_issue_number).toBe(499);

    // pr_list was scoped to the kahuna branch per §5.4.1.
    expect(spy.prListCalls.length).toBe(1);
    const prListArgs = spy.prListCalls[0] as { base?: string; state: string };
    expect(prListArgs.base).toBe('kahuna/499-phase-epic-taxonomy');
    expect(prListArgs.state).toBe('merged');

    // pr_comment was posted on the Plan issue with the canonical body.
    expect(spy.prCommentCalls.length).toBe(1);
    const commentArgs = spy.prCommentCalls[0] as { number: number; body: string };
    expect(commentArgs.number).toBe(499);
    expect(commentArgs.body).toContain('[drift-halt] 2026-04-27T14:55Z · /wavemachine wave-5');
    expect(commentArgs.body).toContain('**Category:** B — Story count / dependency violation');
    expect(commentArgs.body).toContain('**Wave:** Phase 2 Wave 5');
    expect(commentArgs.body).toContain('**Expected stories:** #540 #541 #542');
    expect(commentArgs.body).toContain('**Actual merged:** #540 #542');
    expect(commentArgs.body).toContain('**Missing:** #541');
    expect(commentArgs.body).toContain('**Unexpected:** (none)');
    expect(commentArgs.body).toContain('**Dependency violations:** (none)');
    expect(commentArgs.body).toContain('**Deferrals recorded:** (none)');
    expect(commentArgs.body).toContain('**Next step:**');
  });
});

// ---------------------------------------------------------------------------
// IT-DRIFT-B-02
// ---------------------------------------------------------------------------

describe('IT-DRIFT-B-02 — Story B merges before its depends_on Story A', () => {
  beforeEach(resetExec);
  afterEach(restoreEnv);

  test('Plan where B depends on A; B merges first → dependency-violation [drift-halt]', async () => {
    const plan = {
      plan_id: 499,
      plan_issue: 'Wave-Engineering/claudecode-workflow#499',
      phases: [
        {
          number: 2,
          name: 'Schema & API Renames',
          waves: [
            {
              id: 'P2W6',
              number: 6,
              issues: [
                { number: 550, depends_on: [] },
                // #551 declares a dependency on #550
                { number: 551, depends_on: ['Wave-Engineering/foo#550'] },
              ],
            },
          ],
        },
      ],
    };
    const state = {
      current_wave: 'P2W6',
      waves: { P2W6: { status: 'in_progress' } },
      deferrals: [],
      kahuna_branch: 'kahuna/499-phase-epic-taxonomy',
    };
    await setupFixture(plan, state);

    const { deps, spy } = makeDeps();
    // pr_list returns newest-first (GitHub's default). The handler reverses
    // to produce oldest-first merge order. To simulate "B (#551) merged
    // FIRST, A (#550) merged SECOND", #550 is placed at index 0 (newest) so
    // after reversal #551 appears first in merge order → dep violation.
    spy.prListReturn = {
      ok: true,
      data: {
        prs: [
          { number: 200, title: 't', state: 'merged', head: 'feature/550-a', base: 'kahuna/499-x', url: 'u1' },
          { number: 201, title: 't', state: 'merged', head: 'feature/551-b', base: 'kahuna/499-x', url: 'u2' },
        ],
      },
    };

    const result = await reconcile({
      wave_id: 'P2W6',
      timestamp: '2026-04-27T15:00Z',
    }, deps);

    // --- Assertions ---------------------------------------------------
    expect(result.ok).toBe(true);
    expect(result.drift).toBe(true);
    expect((result.sets as { missing: number[] }).missing).toEqual([]);
    expect((result.sets as { unexpected: number[] }).unexpected).toEqual([]);
    expect((result.sets as { dependencyViolations: Array<{ issue: number; unmet: number[] }> }).dependencyViolations)
      .toEqual([{ issue: 551, unmet: [550] }]);

    // pr_comment posted with dependency-violation body.
    expect(spy.prCommentCalls.length).toBe(1);
    const commentArgs = spy.prCommentCalls[0] as { number: number; body: string };
    expect(commentArgs.number).toBe(499);
    expect(commentArgs.body).toContain('[drift-halt] 2026-04-27T15:00Z · /wavemachine wave-6');
    expect(commentArgs.body).toContain('**Category:** B — Story count / dependency violation');
    expect(commentArgs.body).toContain('**Missing:** (none)');
    expect(commentArgs.body).toContain('**Unexpected:** (none)');
    expect(commentArgs.body).toContain('**Dependency violations:** #551 (depends on #550)');
  });
});
