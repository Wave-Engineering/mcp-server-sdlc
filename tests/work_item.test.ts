import { describe, test, expect, beforeEach } from 'bun:test';
import { installChildProcessMock, onExec, resetExecMock, execCalls } from '../lib/test-support/mock-child-process.ts';

// Integration coverage for the work_item handler post-Story-2.17 (#311).
//
// work_item now dispatches through the platform adapter; per-platform adapters
// call subprocess via `runArgv`, which shell-escapes its argv (e.g.
// `'gh' 'issue' 'create' '--title' 'X'`). The `unquote` shim strips that
// quoting so test match-keys can stay as plain `gh issue create` strings —
// same pattern adopted by tests/label_list.test.ts / tests/label_create.test.ts.
//
// Argv-shape assertions live in the colocated adapter tests
// (lib/adapters/work-item-{github,gitlab}.test.ts). This file owns:
//   - schema validation
//   - handler envelope shape
//   - cross-platform dispatch via detect-platform
//   - #281 regression (cross-platform asymmetry)

interface MockExecError extends Error {
  stderr?: string;
  stdout?: string;
  status?: number;
}

function unquote(cmd: string): string {
  return cmd.replace(/'([^']*)'/g, '$1');
}

installChildProcessMock();

const { default: handler } = await import('../handlers/work_item.ts');

function parseResult(content: Array<{ type: string; text: string }>) {
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

beforeEach(() => {
  resetExecMock();
});

describe('work_item handler', () => {
  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('work_item');
    expect(typeof handler.execute).toBe('function');
  });

  // ---- schema validation ----

  test('schema rejects unknown type', async () => {
    const result = await handler.execute({ type: 'not-a-type', title: 'X' });
    const data = parseResult(result.content);
    expect(data.ok).toBe(false);
    expect(String(data.error)).toMatch(/type/);
  });

  test('schema rejects empty title', async () => {
    const result = await handler.execute({ type: 'story', title: '' });
    const data = parseResult(result.content);
    expect(data.ok).toBe(false);
    expect(String(data.error)).toMatch(/title/);
  });

  // ---- github: issue types ----

  test('github — type:story dispatches to gh issue create', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git');
    onExec('gh issue create', 'https://github.com/org/repo/issues/42\n');

    const result = await handler.execute({ type: 'story', title: 'My story', body: 'details' });
    const data = parseResult(result.content);
    expect(data.ok).toBe(true);
    expect(data.number).toBe(42);
    expect(data.url).toBe('https://github.com/org/repo/issues/42');

    const call = execCalls().find((c) => unquote(c).includes('gh issue create')) ?? '';
    expect(call).toContain("'--title' 'My story'");
    expect(call).toContain("'--label' 'type::story'");
  });

  test('github — type:bug auto-merges type::bug label', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git');
    onExec('gh issue create', 'https://github.com/org/repo/issues/7\n');

    await handler.execute({ type: 'bug', title: 'A bug', labels: ['priority::high'] });

    const call = execCalls().find((c) => unquote(c).includes('gh issue create')) ?? '';
    expect(call).toContain("'--label' 'type::bug'");
    expect(call).toContain("'--label' 'priority::high'");
  });

  test('github — type:doc auto-merges the canonical type::doc label', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git');
    onExec('gh issue create', 'https://github.com/org/repo/issues/8\n');

    const result = await handler.execute({ type: 'doc', title: 'A doc' });
    expect(parseResult(result.content).ok).toBe(true);

    const call = execCalls().find((c) => unquote(c).includes('gh issue create')) ?? '';
    expect(call).toContain("'--label' 'type::doc'");
    expect(call).not.toContain('type::docs'); // the plural myth is never emitted
  });

  test('github — transitional type:docs normalizes to type::doc, never type::docs (#380/#540)', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git');
    onExec('gh issue create', 'https://github.com/org/repo/issues/9\n');

    // The `docs` string is still accepted (cc-workflow /issue skill still emits
    // it) but must resolve to the canonical singular label, not create type::docs.
    const result = await handler.execute({ type: 'docs', title: 'Plural input' });
    expect(parseResult(result.content).ok).toBe(true);

    const call = execCalls().find((c) => unquote(c).includes('gh issue create')) ?? '';
    expect(call).toContain("'--label' 'type::doc'");
    expect(call).not.toContain('type::docs');
  });

  // ---- github: PR ----

  test('github — type:pr dispatches to gh pr create with head/base/draft', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git');
    onExec('gh pr create', 'https://github.com/org/repo/pull/99\n');

    const result = await handler.execute({
      type: 'pr',
      title: 'My PR',
      head_branch: 'feature/1-foo',
      base_branch: 'main',
      draft: true,
    });
    const data = parseResult(result.content);
    expect(data.ok).toBe(true);
    expect(data.number).toBe(99);

    const call = execCalls().find((c) => unquote(c).includes('gh pr create')) ?? '';
    expect(call).toContain("'--head' 'feature/1-foo'");
    expect(call).toContain("'--base' 'main'");
    expect(call).toContain('--draft');
  });

  // ---- #281 regression: cross-platform asymmetry ----

  test("github — type:'mr' returns platform_unsupported (regression for #281)", async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git');

    const result = await handler.execute({ type: 'mr', title: 'Wrong platform' });
    const data = parseResult(result.content);
    expect(data.ok).toBe(false);
    expect(data.platform_unsupported).toBe(true);
    expect(String(data.error)).toContain('type="pr"');
    // Verify NO `glab` sub-command was attempted (only `git remote get-url`).
    const glabCalls = execCalls().filter((c) => unquote(c).includes('glab'));
    expect(glabCalls.length).toBe(0);
  });

  test("gitlab — type:'pr' returns platform_unsupported (regression for #281)", async () => {
    onExec('git remote get-url origin', 'git@gitlab.com:org/repo.git');

    const result = await handler.execute({ type: 'pr', title: 'Wrong platform' });
    const data = parseResult(result.content);
    expect(data.ok).toBe(false);
    expect(data.platform_unsupported).toBe(true);
    expect(String(data.error)).toContain('type="mr"');
    // Verify NO `gh` sub-command was attempted.
    const ghCalls = execCalls().filter((c) => {
      const flat = unquote(c);
      return flat.startsWith('gh ') || flat.includes(' gh ');
    });
    expect(ghCalls.length).toBe(0);
  });

  // ---- gitlab: issue types ----

  test('gitlab — type:story dispatches to glab issue create with -R and CSV labels', async () => {
    onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    onExec('glab issue create', 'https://gitlab.com/org/repo/-/issues/5\n');

    const result = await handler.execute({
      type: 'story',
      title: 'GL story',
      labels: ['team::alpha'],
      repo: 'foo/bar',
    });
    const data = parseResult(result.content);
    expect(data.ok).toBe(true);
    expect(data.number).toBe(5);

    const call = execCalls().find((c) => unquote(c).includes('glab issue create')) ?? '';
    expect(call).toContain("'--title' 'GL story'");
    expect(call).toContain("'--label' 'type::story,team::alpha'");
    expect(call).toContain("'-R' 'foo/bar'");
  });

  // ---- gitlab: MR ----

  test('gitlab — type:mr dispatches to glab mr create with source/target branches', async () => {
    onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    onExec('glab mr create', 'https://gitlab.com/org/repo/-/merge_requests/12\n');

    const result = await handler.execute({
      type: 'mr',
      title: 'My MR',
      head_branch: 'feature/2-bar',
      base_branch: 'main',
    });
    const data = parseResult(result.content);
    expect(data.ok).toBe(true);
    expect(data.number).toBe(12);

    const call = execCalls().find((c) => unquote(c).includes('glab mr create')) ?? '';
    expect(call).toContain("'--source-branch' 'feature/2-bar'");
    expect(call).toContain("'--target-branch' 'main'");
  });

  // ---- error surface ----

  test('github — returns ok:false on subprocess failure', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git');
    onExec('gh issue create', () => {
      const err: MockExecError = new Error('gh not authenticated') as MockExecError;
      err.stderr = 'gh: not authenticated';
      err.status = 1;
      throw err;
    });

    const result = await handler.execute({ type: 'bug', title: 'Boom' });
    const data = parseResult(result.content);
    expect(data.ok).toBe(false);
    expect(String(data.error)).toContain('gh issue create failed');
  });
});
