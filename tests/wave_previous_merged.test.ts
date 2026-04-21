import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';

// Mock only execSync (so this test can intercept gh calls without
// disturbing fs). Other tests that mock child_process use the same
// pattern, so the mock contracts are compatible.

let execMockFn: (cmd: string) => string = () => '';

const mockExecSync = mock((cmd: string, _opts?: unknown) => {
  return execMockFn(cmd);
});

mock.module('child_process', () => ({ execSync: mockExecSync }));

// Helper to build a GraphQL response matching what `gh api graphql` returns
// for the wave_previous_merged closure query. `merged` controls whether the
// linked PR counts as a merged closure; `closerIsPR` controls the timeline
// fallback. Default (both null) represents an OPEN issue.
function ghClosureResponse(opts: {
  state: 'OPEN' | 'CLOSED';
  mergedPRs?: boolean[];
  closerIsPR?: boolean;
}): string {
  return JSON.stringify({
    data: {
      repository: {
        issue: {
          state: opts.state,
          closedByPullRequestsReferences: {
            nodes: (opts.mergedPRs ?? []).map((merged) => ({ merged })),
          },
          timelineItems: {
            nodes: opts.closerIsPR
              ? [{ closer: { __typename: 'PullRequest' } }]
              : [],
          },
        },
      },
    },
  });
}

const { default: handler } = await import('../handlers/wave_previous_merged.ts');

let fixtureDir = '';
const ORIGINAL_ENV = process.env.CLAUDE_PROJECT_DIR;

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

async function setupFixture(plan: object, state: object) {
  fixtureDir = `/tmp/wave-prev-merged-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  const statusDir = `${fixtureDir}/.claude/status`;
  await Bun.write(`${statusDir}/phases-waves.json`, JSON.stringify(plan));
  await Bun.write(`${statusDir}/state.json`, JSON.stringify(state));
  process.env.CLAUDE_PROJECT_DIR = fixtureDir;
}

function resetMocks() {
  execMockFn = () => '';
  mockExecSync.mockClear();
  fixtureDir = '';
}

function restoreEnv() {
  if (ORIGINAL_ENV === undefined) {
    delete process.env.CLAUDE_PROJECT_DIR;
  } else {
    process.env.CLAUDE_PROJECT_DIR = ORIGINAL_ENV;
  }
}

describe('wave_previous_merged handler', () => {
  beforeEach(resetMocks);
  afterEach(restoreEnv);

  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('wave_previous_merged');
    expect(typeof handler.execute).toBe('function');
  });

  test('all_merged_returns_true — every issue closed by a merged PR', async () => {
    const plan = {
      phases: [
        {
          waves: [
            { id: 'w1', issues: [{ number: 1 }, { number: 2 }] },
            { id: 'w2', issues: [{ number: 3 }] },
          ],
        },
      ],
    };
    const state = {
      current_wave: 'w2',
      waves: {
        w1: { status: 'completed' },
        w2: { status: 'in_progress' },
      },
    };
    await setupFixture(plan, state);
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote')) return 'https://github.com/org/repo.git\n';
      return ghClosureResponse({ state: 'CLOSED', mergedPRs: [true], closerIsPR: true });
    };
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.previous_wave_id).toBe('w1');
    expect(parsed.all_merged).toBe(true);
    expect(parsed.open_issues).toEqual([]);
  });

  test('body_keyword_closure — Closes #N body closure counts as merged', async () => {
    // Repro of #183 from cc-workflow beget: an issue CLOSED via `Closes #N`
    // body keyword should resolve as merged. The GraphQL response populates
    // `closedByPullRequestsReferences` even though the REST events API
    // returns `commit_id: null` for this closure style.
    const plan = {
      phases: [{ waves: [{ id: 'w1', issues: [{ number: 10 }] }, { id: 'w2', issues: [] }] }],
    };
    const state = {
      current_wave: 'w2',
      waves: { w1: { status: 'completed' }, w2: { status: 'in_progress' } },
    };
    await setupFixture(plan, state);
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote')) return 'https://github.com/bakeb7j0/beget.git\n';
      // Classic body-keyword shape: timelineItems.closer is PullRequest AND
      // closedByPullRequestsReferences lists the merged PR.
      return ghClosureResponse({ state: 'CLOSED', mergedPRs: [true], closerIsPR: true });
    };
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.all_merged).toBe(true);
    expect(parsed.open_issues).toEqual([]);
  });

  test('manually_closed_not_planned — CLOSED without merged PR stays in open_issues', async () => {
    // Semantic guard: the tool claims "closed via MERGED PR", so a manually
    // closed ("not planned") issue with no linked merged PR must NOT count.
    const plan = {
      phases: [{ waves: [{ id: 'w1', issues: [{ number: 42 }] }, { id: 'w2', issues: [] }] }],
    };
    const state = {
      current_wave: 'w2',
      waves: { w1: { status: 'completed' }, w2: { status: 'in_progress' } },
    };
    await setupFixture(plan, state);
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote')) return 'https://github.com/org/repo.git\n';
      return ghClosureResponse({ state: 'CLOSED', mergedPRs: [], closerIsPR: false });
    };
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.all_merged).toBe(false);
    expect(parsed.open_issues).toEqual([42]);
  });

  test('some_open_returns_list — mix of closed/open issues', async () => {
    const plan = {
      phases: [
        {
          waves: [
            { id: 'w1', issues: [{ number: 1 }, { number: 2 }, { number: 3 }] },
            { id: 'w2', issues: [{ number: 4 }] },
          ],
        },
      ],
    };
    const state = {
      current_wave: 'w2',
      waves: {
        w1: { status: 'completed' },
        w2: { status: 'in_progress' },
      },
    };
    await setupFixture(plan, state);
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote')) return 'https://github.com/org/repo.git\n';
      if (cmd.includes('num=1'))
        return ghClosureResponse({ state: 'CLOSED', mergedPRs: [true] });
      if (cmd.includes('num=2')) return ghClosureResponse({ state: 'OPEN' });
      if (cmd.includes('num=3')) return ghClosureResponse({ state: 'OPEN' });
      return ghClosureResponse({ state: 'CLOSED', mergedPRs: [true] });
    };
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.all_merged).toBe(false);
    expect(parsed.open_issues).toEqual([2, 3]);
  });

  test('pr_merged_without_timeline_closer — merged PR ref alone is sufficient', async () => {
    // Covers the case where the ClosedEvent's closer is a commit (trailer
    // closure) rather than a PullRequest, but the PR is still listed in
    // closedByPullRequestsReferences. The `merged` flag there should be
    // enough on its own.
    const plan = {
      phases: [{ waves: [{ id: 'w1', issues: [{ number: 5 }] }, { id: 'w2', issues: [] }] }],
    };
    const state = {
      current_wave: 'w2',
      waves: { w1: { status: 'completed' }, w2: { status: 'in_progress' } },
    };
    await setupFixture(plan, state);
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote')) return 'https://github.com/org/repo.git\n';
      return ghClosureResponse({ state: 'CLOSED', mergedPRs: [true], closerIsPR: false });
    };
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.all_merged).toBe(true);
  });

  test('gh_command_throws — issue reported as open (safe default)', async () => {
    // Auth failure, missing repo context, network error — any gh invocation
    // failure must land the issue in open_issues rather than crashing the
    // handler or silently reporting success.
    const plan = {
      phases: [{ waves: [{ id: 'w1', issues: [{ number: 7 }] }, { id: 'w2', issues: [] }] }],
    };
    const state = {
      current_wave: 'w2',
      waves: { w1: { status: 'completed' }, w2: { status: 'in_progress' } },
    };
    await setupFixture(plan, state);
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote')) return 'https://github.com/org/repo.git\n';
      throw new Error('gh: not authenticated');
    };
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.open_issues).toEqual([7]);
    expect(parsed.all_merged).toBe(false);
  });

  test('no_previous_wave — first wave case returns ok:true with null id', async () => {
    const plan = {
      phases: [
        {
          waves: [{ id: 'w1', issues: [{ number: 1 }] }],
        },
      ],
    };
    const state = {
      current_wave: 'w1',
      waves: { w1: { status: 'in_progress' } },
    };
    await setupFixture(plan, state);
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.previous_wave_id).toBe(null);
    expect(parsed.all_merged).toBe(true);
    expect(parsed.open_issues).toEqual([]);
  });

  test('handles_missing_state_files — returns structured error', async () => {
    fixtureDir = `/tmp/wave-prev-merged-empty-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    process.env.CLAUDE_PROJECT_DIR = fixtureDir;
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('state files not found');
  });

  test('schema_validation — rejects unknown fields', async () => {
    await setupFixture({ phases: [] }, { waves: {} });
    const result = await handler.execute({ foo: 'bar' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });
});
