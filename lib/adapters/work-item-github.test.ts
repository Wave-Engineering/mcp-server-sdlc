import { describe, test, expect, beforeEach } from 'bun:test';
import {
  installChildProcessMock,
  onExec,
  resetExecMock,
  execCalls,
} from '../test-support/mock-child-process.ts';
import type { AdapterResult, WorkItemResponse } from './types.ts';

// Subprocess-boundary tests for the GitHub work_item adapter (R-15).
// Integration-level coverage (schema validation, handler envelope, cross-platform
// dispatch) stays in tests/work_item.test.ts; this file owns the argv-shape
// assertions that prove the adapter speaks `gh` correctly.
//
// Argv strictness per `lesson_origin_ops_pitfalls.md`: gh takes `--repo` (long
// flag) and `--body <string>` inline — NOT glab's `-R` or `--description`.
// Also covers the typed `platform_unsupported` asymmetry required by #281
// for `type:'mr'` on a GitHub repo.

interface ThrowableError extends Error {
  stderr?: string;
  stdout?: string;
  status?: number;
}

function unquote(cmd: string): string {
  return cmd.replace(/'([^']*)'/g, '$1');
}

installChildProcessMock();

const { workItemGithub } = await import('./work-item-github.ts');

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

describe('workItemGithub — subprocess boundary', () => {
  // --- #281 regression: type:'mr' on GitHub returns platform_unsupported ---

  test("type:'mr' returns platform_unsupported with hint (regression for #281)", async () => {
    const result = await workItemGithub({ type: 'mr', title: 'My MR', head_branch: 'x', base_branch: 'main' });
    expectUnsupported(result);
    expect(result.hint).toContain('type="pr"');
    // No `glab` sub-command should have been attempted.
    expect(execCalls().length).toBe(0);
  });

  // --- issue types → gh issue create ---

  test("argv: gh issue create for type:'story' auto-merges type::story label", async () => {
    onExec('gh issue create', 'https://github.com/org/repo/issues/42\n');

    const result = await workItemGithub({ type: 'story', title: 'My story', body: 'details' });
    expectOk(result);

    const call = findCall('gh issue create');
    expect(call).toContain("'gh' 'issue' 'create'");
    expect(call).toContain("'--title' 'My story'");
    expect(call).toContain("'--body' 'details'");
    expect(call).toContain("'--label' 'type::story'");
    expect(result.data.number).toBe(42);
    expect(result.data.url).toBe('https://github.com/org/repo/issues/42');
  });

  test('argv: forwards caller labels alongside auto type::* label', async () => {
    onExec('gh issue create', 'https://github.com/org/repo/issues/7\n');

    await workItemGithub({ type: 'epic', title: 'Big epic', labels: ['priority::high', 'size::XL'] });

    const call = findCall('gh issue create');
    expect(call).toContain("'--label' 'type::epic'");
    expect(call).toContain("'--label' 'priority::high'");
    expect(call).toContain("'--label' 'size::XL'");
  });

  test('argv: --repo forwarded for cross-repo issue create', async () => {
    onExec('gh issue create', 'https://github.com/foo/bar/issues/3\n');

    await workItemGithub({ type: 'chore', title: 'Cleanup', repo: 'foo/bar' });

    const call = findCall('gh issue create');
    expect(call).toContain("'--repo' 'foo/bar'");
  });

  test('argv: body defaults to empty string when omitted', async () => {
    onExec('gh issue create', 'https://github.com/org/repo/issues/1\n');

    await workItemGithub({ type: 'bug', title: 'No body' });

    const call = findCall('gh issue create');
    expect(call).toContain("'--body' ''");
  });

  // --- type:'pr' → gh pr create ---

  test("argv: gh pr create for type:'pr' with head/base/draft", async () => {
    onExec('gh pr create', 'https://github.com/org/repo/pull/99\n');

    const result = await workItemGithub({
      type: 'pr',
      title: 'My PR',
      body: 'pr body',
      head_branch: 'feature/1-foo',
      base_branch: 'main',
      draft: true,
    });
    expectOk(result);

    const call = findCall('gh pr create');
    expect(call).toContain("'--title' 'My PR'");
    expect(call).toContain("'--body' 'pr body'");
    expect(call).toContain("'--head' 'feature/1-foo'");
    expect(call).toContain("'--base' 'main'");
    expect(call).toContain('--draft');
    expect(result.data.number).toBe(99);
  });

  test("type:'pr' gets no automatic type label; caller labels still forwarded", async () => {
    onExec('gh pr create', 'https://github.com/org/repo/pull/5\n');

    await workItemGithub({ type: 'pr', title: 'Patch', labels: ['size::S'] });

    const call = findCall('gh pr create');
    expect(call).not.toContain('type::pr');
    expect(call).toContain("'--label' 'size::S'");
  });

  test('argv: omits --draft when draft not set', async () => {
    onExec('gh pr create', 'https://github.com/org/repo/pull/5\n');

    await workItemGithub({ type: 'pr', title: 'Patch', head_branch: 'x', base_branch: 'main' });

    const call = findCall('gh pr create');
    expect(call).not.toContain('--draft');
  });

  // --- error surface ---

  test('returns AdapterResult.error on gh issue failure (not thrown)', async () => {
    onExec('gh issue create', () => {
      const err = new Error('gh: not authenticated') as ThrowableError;
      err.stderr = 'gh: not authenticated';
      err.status = 1;
      throw err;
    });

    const result = await workItemGithub({ type: 'bug', title: 'Boom' });
    expectErr(result);
    expect(result.code).toBe('gh_issue_create_failed');
    expect(result.error).toContain('gh issue create failed');
  });

  test('returns AdapterResult.error on gh pr failure (not thrown)', async () => {
    onExec('gh pr create', () => {
      const err = new Error('gh: cannot find base branch') as ThrowableError;
      err.stderr = 'no such ref';
      err.status = 1;
      throw err;
    });

    const result = await workItemGithub({ type: 'pr', title: 'Bad', head_branch: 'nope', base_branch: 'gone' });
    expectErr(result);
    expect(result.code).toBe('gh_pr_create_failed');
  });

  test('shell-escapes titles with embedded quotes', async () => {
    onExec('gh issue create', 'https://github.com/org/repo/issues/1\n');

    await workItemGithub({ type: 'story', title: "it's a story" });

    const call = findCall('gh issue create');
    // shellEscape converts `'` into `'\''`.
    expect(call).toContain(`'it'\\''s a story'`);
  });
});
