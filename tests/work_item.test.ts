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

// ---- #487: body-grammar warning at creation (warn, never reject) ----
//
// work_item is the single choke point every issue passes through, so it runs
// the spec_validate_structure grammar against the supplied body and surfaces
// misses in an additive `body_grammar` field. The issue is ALWAYS created; the
// caller just learns immediately (while the fix-context is still loaded) instead
// of at the /precheck gate. These tests own the warn-not-reject contract.

describe('work_item — body-grammar warning (#487)', () => {
  function mockCreate(number = 42) {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git');
    onExec('gh issue create', `https://github.com/org/repo/issues/${number}\n`);
  }

  interface BodyGrammar {
    valid: boolean;
    missing_sections: string[];
    accepted_headings?: Record<string, string[]>;
  }

  const VALID_BODY =
    '## Changes\nc\n## Tests\nt\n## Acceptance Criteria\n- [ ] ok\n';

  test('body missing ## Tests → issue created, body_grammar flags tests', async () => {
    mockCreate(42);
    const result = await handler.execute({
      type: 'chore',
      title: 'Missing tests',
      body: '## Changes\nc\n## Acceptance Criteria\n- [ ] ok\n',
    });
    const data = parseResult(result.content);
    // Creation still succeeds — warn, never reject.
    expect(data.ok).toBe(true);
    expect(data.number).toBe(42);

    const bg = data.body_grammar as BodyGrammar;
    expect(bg.valid).toBe(false);
    expect(bg.missing_sections).toEqual(['tests']);
    expect(bg.accepted_headings?.tests).toEqual(
      expect.arrayContaining(['## Tests', '## Test Procedures']),
    );
  });

  test('accepted aliases (## Implementation Steps / ## Test Procedures) → valid, no warning', async () => {
    mockCreate(43);
    const result = await handler.execute({
      type: 'story',
      title: 'Alias body',
      body: '## Implementation Steps\n1. do it\n## Test Procedures\n- unit\n## Acceptance Criteria\n- [ ] ok\n',
    });
    const data = parseResult(result.content);
    expect(data.ok).toBe(true);
    expect(data.number).toBe(43);

    const bg = data.body_grammar as BodyGrammar;
    expect(bg.valid).toBe(true);
    expect(bg.missing_sections).toEqual([]);
    // "No warning": accepted_headings is only emitted when something is missing.
    expect(bg.accepted_headings).toBeUndefined();
  });

  // All near-miss headings observed in the field (AC #5): reasonable-looking
  // headings a careful writer picks unprompted, that simply aren't in the alias
  // set. Each must be flagged, and the response must name the accepted set.
  const NEAR_MISSES: Array<{ heading: string; body: string; missing: string; alias: string }> = [
    // babelfish (cc-workflow#915): used `## Fix` for the changes section.
    {
      heading: '## Fix',
      body: '## Fix\nthe thing\n## Tests\nt\n## Acceptance Criteria\n- [ ] ok\n',
      missing: 'changes',
      alias: '## Changes',
    },
    // polyjuice (mcp-server-discord-watcher#28): used `## Proposed fix` for changes.
    {
      heading: '## Proposed fix',
      body: '## Proposed fix\nthe thing\n## Tests\nt\n## Acceptance Criteria\n- [ ] ok\n',
      missing: 'changes',
      alias: '## Changes',
    },
    // polyjuice (mcp-server-discord-watcher#28): used `## Test Plan` for tests.
    {
      heading: '## Test Plan',
      body: '## Changes\nc\n## Test Plan\n- run it\n## Acceptance Criteria\n- [ ] ok\n',
      missing: 'tests',
      alias: '## Tests',
    },
  ];

  for (const { heading, body, missing, alias } of NEAR_MISSES) {
    test(`near-miss heading ${heading} → flagged with accepted_headings present`, async () => {
      mockCreate(50);
      const result = await handler.execute({ type: 'chore', title: `Uses ${heading}`, body });
      const data = parseResult(result.content);
      expect(data.ok).toBe(true);
      expect(data.number).toBe(50);

      const bg = data.body_grammar as BodyGrammar;
      expect(bg.valid).toBe(false);
      expect(bg.missing_sections).toContain(missing);
      expect(bg.accepted_headings).toBeDefined();
      expect(bg.accepted_headings?.[missing]).toEqual(expect.arrayContaining([alias]));
    });
  }

  test('type carrying no structured body (pr) → no body_grammar, no behavior change', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git');
    onExec('gh pr create', 'https://github.com/org/repo/pull/77\n');
    const result = await handler.execute({
      type: 'pr',
      title: 'A PR',
      head_branch: 'feature/1-foo',
      base_branch: 'main',
      // A PR body uses Summary/Changes/Linked Issues/Test Plan — not the issue grammar.
      body: '## Summary\nx\n## Changes\ny\n',
    });
    const data = parseResult(result.content);
    expect(data.ok).toBe(true);
    expect(data.number).toBe(77);
    expect(data.body_grammar).toBeUndefined();
  });

  test('issue type with no body → no body_grammar (nothing to validate)', async () => {
    mockCreate(88);
    const result = await handler.execute({ type: 'chore', title: 'Bodyless chore' });
    const data = parseResult(result.content);
    expect(data.ok).toBe(true);
    expect(data.number).toBe(88);
    expect(data.body_grammar).toBeUndefined();
  });

  test('fully valid body → body_grammar present with valid:true, no accepted_headings', async () => {
    mockCreate(90);
    const result = await handler.execute({ type: 'feature', title: 'Good body', body: VALID_BODY });
    const data = parseResult(result.content);
    expect(data.ok).toBe(true);
    const bg = data.body_grammar as BodyGrammar;
    expect(bg.valid).toBe(true);
    expect(bg.accepted_headings).toBeUndefined();
  });

  test('additive only — existing number/url envelope keys are unchanged', async () => {
    mockCreate(91);
    const result = await handler.execute({
      type: 'bug',
      title: 'Backcompat',
      body: '## Changes\nc\n',
    });
    const data = parseResult(result.content);
    // Pre-#487 callers read these; body_grammar is purely additive alongside them.
    expect(data.ok).toBe(true);
    expect(data.number).toBe(91);
    expect(data.url).toBe('https://github.com/org/repo/issues/91');
  });
});
