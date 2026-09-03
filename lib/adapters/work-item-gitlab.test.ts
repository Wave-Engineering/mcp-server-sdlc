import { describe, test, expect, beforeEach } from 'bun:test';
import {
  installChildProcessMock,
  onExec,
  resetExecMock,
  execCalls,
} from '../test-support/mock-child-process.ts';
import type { AdapterResult, WorkItemResponse } from './types.ts';

// Subprocess-boundary tests for the GitLab work_item adapter (R-15).
// Integration-level coverage (schema validation, handler envelope, cross-platform
// dispatch) stays in tests/work_item.test.ts; this file owns the argv-shape
// assertions that prove the adapter speaks `glab` correctly.
//
// Argv strictness per `lesson_origin_ops_pitfalls.md`: glab takes `-R` (short
// flag) and `--description <string>` — NOT gh's `--repo` or `--body`. Also
// covers the typed `platform_unsupported` asymmetry required by #281 for
// `type:'pr'` on a GitLab repo.

interface ThrowableError extends Error {
  stderr?: string;
  stdout?: string;
  status?: number;
}

function unquote(cmd: string): string {
  return cmd.replace(/'([^']*)'/g, '$1');
}

installChildProcessMock();

const { workItemGitlab } = await import('./work-item-gitlab.ts');

function expectOk(
  r: AdapterResult<WorkItemResponse>,
): asserts r is { ok: true; data: WorkItemResponse } {
  if (!('ok' in r) || !r.ok) {
    throw new Error(`expected ok result, got ${JSON.stringify(r)}`);
  }
}

function expectErr(
  r: AdapterResult<WorkItemResponse>,
): asserts r is { ok: false; error: string; code: string } {
  if (!('ok' in r) || r.ok) {
    throw new Error(`expected error result, got ${JSON.stringify(r)}`);
  }
}

function expectUnsupported(
  r: AdapterResult<WorkItemResponse>,
): asserts r is { platform_unsupported: true; hint: string } {
  if (!('platform_unsupported' in r)) {
    throw new Error(`expected platform_unsupported, got ${JSON.stringify(r)}`);
  }
}

function findCall(needle: string): string {
  return execCalls().find((c) => c.includes(needle) || unquote(c).includes(needle)) ?? '';
}

beforeEach(() => {
  resetExecMock();
});

describe('workItemGitlab — subprocess boundary', () => {
  // --- #281 regression: type:'pr' on GitLab returns platform_unsupported ---

  test("type:'pr' returns platform_unsupported with hint (regression for #281)", async () => {
    const result = await workItemGitlab({ type: 'pr', title: 'My PR', head_branch: 'x', base_branch: 'main' });
    expectUnsupported(result);
    expect(result.hint).toContain('type="mr"');
    // No `gh` sub-command should have been attempted.
    expect(execCalls().length).toBe(0);
  });

  // --- issue types → glab issue create ---

  test("argv: glab issue create for type:'story' auto-merges type::story label", async () => {
    onExec('glab issue create', 'https://gitlab.com/org/repo/-/issues/7\n');

    const result = await workItemGitlab({ type: 'story', title: 'GL story', body: 'details' });
    expectOk(result);

    const call = findCall('glab issue create');
    expect(call).toContain("'glab' 'issue' 'create'");
    expect(call).toContain("'--title' 'GL story'");
    expect(call).toContain("'--description' 'details'");
    expect(call).toContain("'--label' 'type::story'");
    expect(result.data.number).toBe(7);
  });

  test('argv: forwards caller labels as CSV alongside auto type::* label', async () => {
    onExec('glab issue create', 'https://gitlab.com/org/repo/-/issues/12\n');

    await workItemGitlab({ type: 'bug', title: 'A bug', labels: ['priority::high', 'team::alpha'] });

    const call = findCall('glab issue create');
    // glab wants a single comma-separated --label value.
    expect(call).toContain("'--label' 'type::bug,priority::high,team::alpha'");
  });

  test('argv: -R (not --repo) forwarded for cross-repo issue create', async () => {
    onExec('glab issue create', 'https://gitlab.com/foo/bar/-/issues/3\n');

    await workItemGitlab({ type: 'chore', title: 'Cleanup', repo: 'foo/bar' });

    const call = findCall('glab issue create');
    expect(call).toContain("'-R' 'foo/bar'");
    expect(call).not.toContain('--repo');
  });

  // --- type:'mr' → glab mr create ---

  test("argv: glab mr create for type:'mr' with source/target/draft", async () => {
    onExec('glab mr create', 'https://gitlab.com/org/repo/-/merge_requests/99\n');
    // Self-assign resolves the current user via `glab api /user` (#577).
    onExec('glab api /user', JSON.stringify({ username: 'bj-bots' }));

    const result = await workItemGitlab({
      type: 'mr',
      title: 'My MR',
      body: 'mr body',
      head_branch: 'feature/2-bar',
      base_branch: 'main',
      draft: true,
    });
    expectOk(result);

    const call = findCall('glab mr create');
    expect(call).toContain("'--title' 'My MR'");
    expect(call).toContain("'--description' 'mr body'");
    expect(call).toContain("'--source-branch' 'feature/2-bar'");
    expect(call).toContain("'--target-branch' 'main'");
    expect(call).toContain('--draft');
    // Self-assign at creation (#577): resolved username, not gh's `@me`.
    expect(call).toContain("'--assignee' 'bj-bots'");
    expect(result.data.number).toBe(99);
  });

  test("type:'mr' self-assign is omitted (not fatal) when glab api /user fails (#577)", async () => {
    onExec('glab mr create', 'https://gitlab.com/org/repo/-/merge_requests/8\n');
    // No `glab api /user` stub → unmatched → resolveGitlabSelfSync returns null.
    const result = await workItemGitlab({ type: 'mr', title: 'Solo', head_branch: 'x', base_branch: 'main' });
    expectOk(result);
    const call = findCall('glab mr create');
    expect(call).not.toContain('--assignee');
    expect(result.data.number).toBe(8);
  });

  test("type:'mr' gets no automatic type label; caller labels still forwarded as CSV", async () => {
    onExec('glab mr create', 'https://gitlab.com/org/repo/-/merge_requests/5\n');

    await workItemGitlab({ type: 'mr', title: 'Patch', labels: ['size::S', 'team::beta'] });

    const call = findCall('glab mr create');
    expect(call).not.toContain('type::mr');
    expect(call).toContain("'--label' 'size::S,team::beta'");
  });

  test('argv: omits --label when no labels supplied for MR', async () => {
    onExec('glab mr create', 'https://gitlab.com/org/repo/-/merge_requests/5\n');

    await workItemGitlab({ type: 'mr', title: 'Patch', head_branch: 'x', base_branch: 'main' });

    const call = findCall('glab mr create');
    expect(call).not.toContain('--label');
  });

  // --- error surface ---

  test('returns AdapterResult.error on glab issue failure (not thrown)', async () => {
    onExec('glab issue create', () => {
      const err = new Error('glab: not authenticated') as ThrowableError;
      err.stderr = 'glab: not authenticated';
      err.status = 1;
      throw err;
    });

    const result = await workItemGitlab({ type: 'bug', title: 'Boom' });
    expectErr(result);
    expect(result.code).toBe('glab_issue_create_failed');
    expect(result.error).toContain('glab issue create failed');
  });

  test('returns AdapterResult.error on glab mr failure (not thrown)', async () => {
    onExec('glab mr create', () => {
      const err = new Error('glab: cannot find target branch') as ThrowableError;
      err.stderr = 'no such ref';
      err.status = 1;
      throw err;
    });

    const result = await workItemGitlab({ type: 'mr', title: 'Bad', head_branch: 'x', base_branch: 'gone' });
    expectErr(result);
    expect(result.code).toBe('glab_mr_create_failed');
  });
});

describe('type::plan + the platform-independent auto-label (#477)', () => {
  test('type: "plan" applies type::plan', async () => {
    onExec('glab issue create', 'https://gitlab.com/org/repo/-/issues/167');
    const r = await workItemGitlab({ type: 'plan', title: 'Plan: X' });
    if (!('ok' in r) || !r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
    expect(execCalls().join(' ')).toContain('type::plan');
  });

  test('a caller-supplied type:: label suppresses the auto-label HERE TOO', async () => {
    // GitLab hid this bug: scoped labels are mutually exclusive within the
    // `type::` key, so the caller's later type::plan evicted our type::epic and
    // nobody noticed. We now suppress it explicitly on BOTH platforms rather than
    // depending on GitLab to clean up after us — the same call on GitHub carried
    // both labels.
    onExec('glab issue create', 'https://gitlab.com/org/repo/-/issues/167');
    const r = await workItemGitlab({
      type: 'epic',
      title: 'Plan: X',
      labels: ['type::plan'],
    });
    if (!('ok' in r) || !r.ok) throw new Error('expected ok');

    const call = execCalls().join(' ');
    expect(call).toContain('type::plan');
    expect(call).not.toContain('type::epic');
  });
});
