import { describe, test, expect, mock, beforeEach } from 'bun:test';
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

let execRegistry: Array<{ match: string; respond: string | (() => string) }> = [];
let execCalls: string[] = [];

function unquote(cmd: string): string {
  return cmd.replace(/'([^']*)'/g, '$1');
}

const mockExecSync = mock((cmd: string, _opts?: unknown) => {
  execCalls.push(cmd);
  const flat = unquote(cmd);
  // Argv strictness — gh-style flags on the glab path means we regressed.
  if (
    (flat.includes('glab issue create') || flat.includes('glab mr create')) &&
    (/--repo\s/.test(flat) || /--body\s/.test(flat) || /--head\s/.test(flat) || /--base\s/.test(flat))
  ) {
    const err = new Error(
      `FAIL: glab ${flat.includes('issue') ? 'issue' : 'mr'} create invoked with gh-style flags`,
    ) as ThrowableError;
    err.status = 127;
    throw err;
  }
  for (const { match, respond } of execRegistry) {
    if (cmd.includes(match) || flat.includes(match)) {
      return typeof respond === 'function' ? respond() : respond;
    }
  }
  const err = new Error(`Unexpected exec: ${cmd}`) as ThrowableError;
  err.stderr = `Unexpected exec: ${cmd}`;
  err.status = 127;
  throw err;
});

mock.module('child_process', () => ({ execSync: mockExecSync }));

const { workItemGitlab } = await import('./work-item-gitlab.ts');

function on(match: string, respond: string | (() => string)): void {
  execRegistry.push({ match, respond });
}

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
  return execCalls.find((c) => c.includes(needle) || unquote(c).includes(needle)) ?? '';
}

beforeEach(() => {
  execRegistry = [];
  execCalls = [];
});

describe('workItemGitlab — subprocess boundary', () => {
  // --- #281 regression: type:'pr' on GitLab returns platform_unsupported ---

  test("type:'pr' returns platform_unsupported with hint (regression for #281)", async () => {
    const result = await workItemGitlab({ type: 'pr', title: 'My PR', head_branch: 'x', base_branch: 'main' });
    expectUnsupported(result);
    expect(result.hint).toContain('type="mr"');
    // No `gh` sub-command should have been attempted.
    expect(execCalls.length).toBe(0);
  });

  // --- issue types → glab issue create ---

  test("argv: glab issue create for type:'story' auto-merges type::story label", async () => {
    on('glab issue create', 'https://gitlab.com/org/repo/-/issues/7\n');

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
    on('glab issue create', 'https://gitlab.com/org/repo/-/issues/12\n');

    await workItemGitlab({ type: 'bug', title: 'A bug', labels: ['priority::high', 'team::alpha'] });

    const call = findCall('glab issue create');
    // glab wants a single comma-separated --label value.
    expect(call).toContain("'--label' 'type::bug,priority::high,team::alpha'");
  });

  test('argv: -R (not --repo) forwarded for cross-repo issue create', async () => {
    on('glab issue create', 'https://gitlab.com/foo/bar/-/issues/3\n');

    await workItemGitlab({ type: 'chore', title: 'Cleanup', repo: 'foo/bar' });

    const call = findCall('glab issue create');
    expect(call).toContain("'-R' 'foo/bar'");
    expect(call).not.toContain('--repo');
  });

  // --- type:'mr' → glab mr create ---

  test("argv: glab mr create for type:'mr' with source/target/draft", async () => {
    on('glab mr create', 'https://gitlab.com/org/repo/-/merge_requests/99\n');

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
    expect(result.data.number).toBe(99);
  });

  test("type:'mr' gets no automatic type label; caller labels still forwarded as CSV", async () => {
    on('glab mr create', 'https://gitlab.com/org/repo/-/merge_requests/5\n');

    await workItemGitlab({ type: 'mr', title: 'Patch', labels: ['size::S', 'team::beta'] });

    const call = findCall('glab mr create');
    expect(call).not.toContain('type::mr');
    expect(call).toContain("'--label' 'size::S,team::beta'");
  });

  test('argv: omits --label when no labels supplied for MR', async () => {
    on('glab mr create', 'https://gitlab.com/org/repo/-/merge_requests/5\n');

    await workItemGitlab({ type: 'mr', title: 'Patch', head_branch: 'x', base_branch: 'main' });

    const call = findCall('glab mr create');
    expect(call).not.toContain('--label');
  });

  // --- error surface ---

  test('returns AdapterResult.error on glab issue failure (not thrown)', async () => {
    on('glab issue create', () => {
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
    on('glab mr create', () => {
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
