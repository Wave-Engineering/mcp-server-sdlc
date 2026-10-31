import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  installChildProcessMock,
  onExec,
  resetExecMock,
  execCalls,
} from '../lib/test-support/mock-child-process.ts';

// wave_ec_sync handler (#613): plan-file read → issueComments adapter → parse →
// plan-file write. Fixtures use Bun.write / Bun.file rather than `fs`, which
// sibling test files mock.module.

interface MockExecError extends Error {
  stderr?: string;
  status?: number;
}

installChildProcessMock();

const { default: handler } = await import('../handlers/wave_ec_sync.ts');

let fixtureDir = '';
const ORIGINAL_ENV = process.env.CLAUDE_PROJECT_DIR;

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

function planPath(): string {
  return `${fixtureDir}/.claude/status/phases-waves.json`;
}

async function setupPlan(plan: object): Promise<string> {
  fixtureDir = `/tmp/wave-ec-sync-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  const text = JSON.stringify(plan);
  await Bun.write(planPath(), text);
  process.env.CLAUDE_PROJECT_DIR = fixtureDir;
  return text;
}

type GhComment = { body: string; created_at: string; url?: string; author?: string; association?: string };

// One `gh api … --jq '… | @json'` output line per comment. Comments default to
// a trusted author; pass `association` to override.
function ghLines(comments: GhComment[]): string {
  return comments.map((c) => JSON.stringify({ association: 'OWNER', ...c })).join('\n') + '\n';
}

function onGithubComments(comments: GhComment[]) {
  onExec('git remote get-url origin', 'https://github.com/org/repo.git');
  onExec('/comments', ghLines(comments));
}

const declaredPlan = {
  plan_id: 600,
  project: 'org/repo',
  entry_conditions: {
    'EC-1': { status: 'unmet', gates: 'start' },
    'EC-2': { status: 'met', gates: 'delivery' },
  },
  phases: [{ waves: [{ id: 'w1', issues: [{ number: 10, ec: ['EC-1', 'EC-3'] }] }] }],
};

beforeEach(() => {
  resetExecMock();
  fixtureDir = '';
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = ORIGINAL_ENV;
});

describe('wave_ec_sync handler', () => {
  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('wave_ec_sync');
    expect(typeof handler.execute).toBe('function');
  });

  test('writes the latest state per declared EC and reports the rest', async () => {
    await setupPlan(declaredPlan);
    onGithubComments([
      { body: '[ec-state EC-1] unmet', created_at: '2026-10-01T00:00:00Z' },
      { body: '[ec-state EC-1] met — https://e/1', created_at: '2026-10-02T00:00:00Z' },
      { body: '[ec-state EC-9] met', created_at: '2026-10-03T00:00:00Z' },
      { body: '[ec-state EC-1] mett', created_at: '2026-10-04T00:00:00Z' },
    ]);

    const parsed = parseResult(await handler.execute({}));
    expect(parsed.ok).toBe(true);
    expect(parsed.written).toBe(true);
    expect(parsed.plan_issue).toBe(600);
    // The garbled latest line reads as unmet: a stale met does not survive it.
    expect(parsed.entry_conditions['EC-1'].status).toBe('unmet');
    expect(parsed.malformed).toHaveLength(1);
    // EC-2 had no comment: written unmet, even though the stored value was met.
    expect(parsed.entry_conditions['EC-2']).toMatchObject({ status: 'unmet', gates: 'delivery' });
    expect(parsed.no_comment).toEqual(['EC-2']);
    expect(parsed.undeclared_in_comments).toEqual(['EC-9']);
    expect(parsed.undeclared_in_plan).toEqual([{ ec: 'EC-3', issues: [10] }]);

    const onDisk = await Bun.file(planPath()).json();
    expect(onDisk.entry_conditions).toEqual(parsed.entry_conditions);
    // Everything else in the plan is carried through untouched.
    expect(onDisk.phases).toEqual(declaredPlan.phases);
    expect(onDisk.plan_id).toBe(600);
  });

  test('positive control — a clean latest met is written met', async () => {
    await setupPlan(declaredPlan);
    onGithubComments([
      { body: '[ec-state EC-1] met — https://e/1', created_at: '2026-10-02T00:00:00Z' },
    ]);
    const parsed = parseResult(await handler.execute({}));
    expect(parsed.entry_conditions['EC-1']).toEqual({
      status: 'met',
      gates: 'start',
      evidence: 'https://e/1',
      updated_at: '2026-10-02T00:00:00Z',
    });
  });

  test('reads comments from the plan file\'s project and plan_id', async () => {
    await setupPlan(declaredPlan);
    onGithubComments([]);
    await handler.execute({});
    const call = execCalls().find((c) => c.includes('/comments')) ?? '';
    expect(call.replace(/'/g, '')).toContain('repos/org/repo/issues/600/comments');
  });

  test('plan_issue ref `owner/repo#N` supplies both number and repo', async () => {
    await setupPlan({ ...declaredPlan, plan_id: undefined, project: undefined, plan_issue: 'acme/plans#77' });
    onGithubComments([]);
    const parsed = parseResult(await handler.execute({}));
    expect(parsed.plan_issue).toBe(77);
    const call = execCalls().find((c) => c.includes('/comments')) ?? '';
    expect(call.replace(/'/g, '')).toContain('repos/acme/plans/issues/77/comments');
  });

  test('ec_untrusted_ignored — a drive-by met is not written, and is reported', async () => {
    await setupPlan(declaredPlan);
    onGithubComments([
      { body: '[ec-state EC-1] met — https://e/1', created_at: '2026-10-02T00:00:00Z', author: 'rando', association: 'NONE' },
    ]);
    const parsed = parseResult(await handler.execute({}));
    expect(parsed.entry_conditions['EC-1'].status).toBe('unmet');
    expect(parsed.untrusted).toEqual([
      { line: '[ec-state EC-1] met — https://e/1', author: 'rando', created_at: '2026-10-02T00:00:00Z' },
    ]);
    expect((await Bun.file(planPath()).json()).entry_conditions['EC-1'].status).toBe('unmet');
  });

  test('ambiguous_plan_issue — plan_id and plan_issue disagree → refuse, plan untouched', async () => {
    const before = await setupPlan({ ...declaredPlan, plan_id: 600, plan_issue: 'acme/plans#77' });
    const parsed = parseResult(await handler.execute({}));
    expect(parsed).toMatchObject({ ok: false, code: 'ambiguous_plan_issue' });
    expect(execCalls().some((c) => c.includes('/comments'))).toBe(false);
    expect(await Bun.file(planPath()).text()).toBe(before);
  });

  test('positive control — plan_id and plan_issue that agree read the ref\'s repo', async () => {
    await setupPlan({ ...declaredPlan, plan_id: 77, plan_issue: 'acme/plans#77' });
    onGithubComments([]);
    const parsed = parseResult(await handler.execute({}));
    expect(parsed.ok).toBe(true);
    const call = execCalls().find((c) => c.includes('/comments')) ?? '';
    expect(call.replace(/'/g, '')).toContain('repos/acme/plans/issues/77/comments');
  });

  test('an explicit plan_issue is read against the plan\'s own project, not the file ref\'s repo', async () => {
    await setupPlan({ ...declaredPlan, plan_issue: 'acme/plans#77' });
    onGithubComments([]);
    const parsed = parseResult(await handler.execute({ plan_issue: 5 }));
    expect(parsed.plan_issue).toBe(5);
    const call = execCalls().find((c) => c.includes('/comments')) ?? '';
    expect(call.replace(/'/g, '')).toContain('repos/org/repo/issues/5/comments');
  });

  test('dry_run reports without writing', async () => {
    const before = await setupPlan(declaredPlan);
    onGithubComments([{ body: '[ec-state EC-1] met', created_at: '2026-10-02T00:00:00Z' }]);
    const parsed = parseResult(await handler.execute({ dry_run: true }));
    expect(parsed.ok).toBe(true);
    expect(parsed.written).toBe(false);
    expect(parsed.entry_conditions['EC-1'].status).toBe('met');
    expect(await Bun.file(planPath()).text()).toBe(before);
  });

  test('legacy plan with no declared ECs is left byte-for-byte untouched', async () => {
    const before = await setupPlan({ plan_id: 5, phases: [{ waves: [{ id: 'w1', issues: [{ number: 1 }] }] }] });
    onGithubComments([{ body: '[ec-state EC-1] met', created_at: '2026-10-02T00:00:00Z' }]);
    const parsed = parseResult(await handler.execute({}));
    expect(parsed.ok).toBe(true);
    expect(parsed.written).toBe(false);
    expect(parsed.undeclared_in_comments).toEqual(['EC-1']);
    expect(await Bun.file(planPath()).text()).toBe(before);
  });

  test('no Plan issue anywhere → no_plan_issue', async () => {
    await setupPlan({ entry_conditions: {}, phases: [] });
    const parsed = parseResult(await handler.execute({}));
    expect(parsed).toMatchObject({ ok: false, code: 'no_plan_issue' });
  });

  test('missing plan file → plan_not_found', async () => {
    fixtureDir = `/tmp/wave-ec-sync-missing-${Date.now()}`;
    process.env.CLAUDE_PROJECT_DIR = fixtureDir;
    const parsed = parseResult(await handler.execute({ plan_issue: 1 }));
    expect(parsed).toMatchObject({ ok: false, code: 'plan_not_found' });
  });

  test('adapter failure relays its code and leaves the plan untouched', async () => {
    const before = await setupPlan(declaredPlan);
    onExec('git remote get-url origin', 'https://github.com/org/repo.git');
    onExec('/comments', () => {
      const e: MockExecError = new Error('boom');
      e.stderr = 'HTTP 403';
      e.status = 1;
      throw e;
    });
    const parsed = parseResult(await handler.execute({}));
    expect(parsed).toMatchObject({ ok: false, code: 'gh_issue_comments_failed' });
    expect(await Bun.file(planPath()).text()).toBe(before);
  });
});
