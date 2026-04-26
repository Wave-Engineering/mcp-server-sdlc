import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';

// pr_comment now uses child_process.execSync (story #253 — sweep follow-up to
// #238). Tests intercept the boundary via `mock.module('child_process', ...)`
// — same pattern as pr_create.test.ts and pr_merge.test.ts. Each test populates
// `execRegistry` with substring → responder mappings; an unmatched call throws
// so missing stubs surface loudly.

interface ThrowableError extends Error {
  stderr?: string;
  stdout?: string;
  status?: number;
}

type Responder = string | (() => string);

let execRegistry: Array<{ match: string; respond: Responder }> = [];
let execCalls: string[] = [];

// Strip the shell-quoting layer the handler applies so test match-keys can be
// authored as plain `gh pr comment` rather than `'gh' 'pr' 'comment'`. We only
// remove single-quotes that surround whole tokens — argument values that
// happen to contain quoted substrings still match correctly.
function unquote(cmd: string): string {
  return cmd.replace(/'([^']*)'/g, '$1');
}

function mockExec(cmd: string): string {
  execCalls.push(cmd);
  const flat = unquote(cmd);
  for (const { match, respond } of execRegistry) {
    if (cmd.includes(match) || flat.includes(match)) {
      return typeof respond === 'function' ? respond() : respond;
    }
  }
  const err = new Error(`Unexpected exec call: ${cmd}`) as ThrowableError;
  err.stderr = `Unexpected exec call: ${cmd}`;
  err.status = 127;
  throw err;
}

mock.module('child_process', () => ({
  execSync: (cmd: string, _opts?: unknown) => mockExec(cmd),
}));

const { default: handler } = await import('../handlers/pr_comment.ts');

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

function onExec(match: string, respond: Responder) {
  execRegistry.push({ match, respond });
}

// Locate a recorded call whose unquoted form contains `needle`. Returns the
// raw (still-quoted) call so flag-presence assertions still see the literal
// argv (e.g. `--repo`, `-R`).
function findCall(needle: string): string {
  return execCalls.find((c) => c.includes(needle) || unquote(c).includes(needle)) ?? '';
}

function failExec(match: string, stderr: string, status: number = 1): void {
  onExec(match, () => {
    const err = new Error(stderr) as ThrowableError;
    err.stderr = stderr;
    err.stdout = '';
    err.status = status;
    throw err;
  });
}

beforeEach(() => {
  execRegistry = [];
  execCalls = [];
});

afterEach(() => {
  execRegistry = [];
  execCalls = [];
});

describe('pr_comment handler', () => {
  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('pr_comment');
    expect(typeof handler.execute).toBe('function');
    expect(handler.description.length).toBeGreaterThan(0);
  });

  // --- schema validation ---

  test('rejects missing number', async () => {
    const result = await handler.execute({ body: 'hi' });
    const data = parseResult(result);
    expect(data.ok).toBe(false);
  });

  test('rejects empty body', async () => {
    const result = await handler.execute({ number: 12, body: '' });
    const data = parseResult(result);
    expect(data.ok).toBe(false);
    expect(data.error as string).toContain('body');
  });

  test('invalid_slug_early_error — returns ok:false without spawning gh/glab', async () => {
    // No execRegistry entries — any spawn would throw 'Unexpected exec call'.
    const result = await handler.execute({
      number: 1,
      body: 'x',
      repo: 'not-a-slug',
    });
    const data = parseResult(result);
    expect(data.ok).toBe(false);
    expect(String(data.error)).toContain('repo');
    // No execSync calls should have been made.
    expect(execCalls.length).toBe(0);
  });

  // --- github happy paths ---

  test('github — plain text comment returns numeric comment_id and url', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git\n');
    onExec(
      'gh pr comment 42',
      'https://github.com/org/repo/pull/42#issuecomment-1001\n',
    );

    const result = await handler.execute({ number: 42, body: 'looks good' });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.number).toBe(42);
    expect(data.comment_id).toBe(1001);
    expect(data.url).toBe('https://github.com/org/repo/pull/42#issuecomment-1001');

    // Argv-shape: gh pr comment <num> --body <body>
    const ghCall = findCall('gh pr comment');
    expect(ghCall).toContain("'gh'");
    expect(ghCall).toContain("'pr'");
    expect(ghCall).toContain("'comment'");
    expect(ghCall).toContain("'42'");
    expect(ghCall).toContain("'--body'");
    expect(ghCall).toContain("'looks good'");
  });

  test('github — markdown body (code fence, bold, link, list) round-trips verbatim', async () => {
    onExec('git remote get-url origin', 'git@github.com:org/repo.git\n');
    onExec(
      'gh pr comment 7',
      'https://github.com/org/repo/pull/7#issuecomment-2002\n',
    );

    const body = [
      '**heads up** — see [issue](https://example.com/x)',
      '',
      '```ts',
      'const x: number = 1;',
      'console.log(`hello ${x}`);',
      '```',
      '',
      '- item one',
      '- item two',
    ].join('\n');

    const result = await handler.execute({ number: 7, body });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.comment_id).toBe(2002);

    // Body survives shell-escaping: assert each non-trivial line is present
    // verbatim in the unquoted command. (Newlines inside single-quoted shell
    // strings are preserved literally — no escaping needed.)
    const ghCall = findCall('gh pr comment');
    const flat = unquote(ghCall);
    expect(flat).toContain('**heads up**');
    expect(flat).toContain('[issue](https://example.com/x)');
    expect(flat).toContain('```ts');
    expect(flat).toContain('const x: number = 1;');
    expect(flat).toContain('console.log(`hello ${x}`);');
    expect(flat).toContain('- item one');
    expect(flat).toContain('- item two');
  });

  test('github — unicode and emoji body preserved verbatim', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git\n');
    onExec(
      'gh pr comment 3',
      'https://github.com/org/repo/pull/3#issuecomment-3003\n',
    );

    const body = 'LGTM — 🚀 中文 тест αβγ';

    const result = await handler.execute({ number: 3, body });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.comment_id).toBe(3003);

    const ghCall = findCall('gh pr comment');
    expect(unquote(ghCall)).toContain(body);
  });

  // --- gitlab happy paths ---

  test('gitlab — plain text comment returns numeric comment_id and url', async () => {
    onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git\n');
    onExec(
      'glab mr note 55',
      'https://gitlab.com/org/repo/-/merge_requests/55#note_9090\n',
    );

    const result = await handler.execute({ number: 55, body: 'ship it' });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.number).toBe(55);
    expect(data.comment_id).toBe(9090);
    expect(data.url).toBe('https://gitlab.com/org/repo/-/merge_requests/55#note_9090');

    const glabCall = findCall('glab mr note');
    expect(glabCall).toContain("'glab'");
    expect(glabCall).toContain("'mr'");
    expect(glabCall).toContain("'note'");
    expect(glabCall).toContain("'55'");
    expect(glabCall).toContain("'--message'");
    expect(glabCall).toContain("'ship it'");
  });

  test('gitlab — markdown body with code fence preserved verbatim', async () => {
    onExec('git remote get-url origin', 'git@gitlab.com:org/repo.git\n');
    onExec(
      'glab mr note 88',
      'https://gitlab.com/org/repo/-/merge_requests/88#note_7070\n',
    );

    const body = [
      '### Review findings',
      '',
      '```python',
      'def hello():',
      '    print("world")',
      '```',
    ].join('\n');

    const result = await handler.execute({ number: 88, body });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.comment_id).toBe(7070);

    const glabCall = findCall('glab mr note');
    const flat = unquote(glabCall);
    expect(flat).toContain('### Review findings');
    expect(flat).toContain('```python');
    expect(flat).toContain('def hello():');
    expect(flat).toContain('print("world")');
  });

  test('gitlab — unicode body preserved', async () => {
    onExec('git remote get-url origin', 'https://gitlab.example.com/team/proj.git\n');
    onExec(
      'glab mr note 11',
      'https://gitlab.example.com/team/proj/-/merge_requests/11#note_2222\n',
    );

    const body = '✅ passed: 42 ❌ failed: 0 — 完了';

    const result = await handler.execute({ number: 11, body });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.comment_id).toBe(2222);

    const glabCall = findCall('glab mr note');
    expect(unquote(glabCall)).toContain(body);
  });

  // --- error paths ---

  test('github — gh failure is returned as structured error, not thrown', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git\n');
    failExec('gh pr comment 9999', 'HTTP 404: Not Found', 1);

    const result = await handler.execute({ number: 9999, body: 'nope' });
    const data = parseResult(result);

    expect(data.ok).toBe(false);
    expect(data.error as string).toContain('gh pr comment failed');
    expect(data.error as string).toContain('HTTP 404');
  });

  test('github — unparseable stdout (no issuecomment id) returns structured error', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git\n');
    onExec('gh pr comment 1', 'posted comment ok\n');

    const result = await handler.execute({ number: 1, body: 'x' });
    const data = parseResult(result);

    expect(data.ok).toBe(false);
    expect(data.error as string).toContain('failed to parse comment ID');
  });

  test('gitlab — glab failure is returned as structured error, not thrown', async () => {
    onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git\n');
    failExec('glab mr note 9999', 'permission denied', 1);

    const result = await handler.execute({ number: 9999, body: 'nope' });
    const data = parseResult(result);

    expect(data.ok).toBe(false);
    expect(data.error as string).toContain('glab mr note failed');
    expect(data.error as string).toContain('permission denied');
  });

  test('gitlab — unparseable stdout (no note id) returns structured error', async () => {
    onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git\n');
    onExec('glab mr note 1', 'posted note ok\n');

    const result = await handler.execute({ number: 1, body: 'x' });
    const data = parseResult(result);

    expect(data.ok).toBe(false);
    expect(data.error as string).toContain('failed to parse note ID');
  });

  // --- cross-repo routing ---

  test('route_with_repo — github appends --repo and slug to gh argv', async () => {
    // cwd remote is a DIFFERENT repo than the target.
    onExec('git remote get-url origin', 'https://github.com/cwd-org/cwd-repo.git\n');
    onExec(
      'gh pr comment 42',
      'https://github.com/Wave-Engineering/mcp-server-sdlc/pull/42#issuecomment-1001\n',
    );

    const result = await handler.execute({
      number: 42,
      body: 'cross-repo comment',
      repo: 'Wave-Engineering/mcp-server-sdlc',
    });
    const data = parseResult(result);
    expect(data.ok).toBe(true);

    const ghCall = findCall('gh pr comment');
    expect(ghCall).toContain("'--repo'");
    expect(ghCall).toContain("'Wave-Engineering/mcp-server-sdlc'");
  });

  test('route_with_repo — gitlab appends -R and slug to glab argv', async () => {
    onExec('git remote get-url origin', 'https://gitlab.com/cwd-org/cwd-repo.git\n');
    onExec(
      'glab mr note 55',
      'https://gitlab.com/target-org/target-repo/-/merge_requests/55#note_9090\n',
    );

    const result = await handler.execute({
      number: 55,
      body: 'cross-repo note',
      repo: 'target-org/target-repo',
    });
    const data = parseResult(result);
    expect(data.ok).toBe(true);

    const glabCall = findCall('glab mr note');
    expect(glabCall).toContain("'-R'");
    expect(glabCall).toContain("'target-org/target-repo'");
  });

  test('regression_without_repo — gh argv does NOT contain --repo', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git\n');
    onExec(
      'gh pr comment 42',
      'https://github.com/org/repo/pull/42#issuecomment-1001\n',
    );

    const result = await handler.execute({ number: 42, body: 'hi' });
    const data = parseResult(result);
    expect(data.ok).toBe(true);

    const ghCall = findCall('gh pr comment');
    expect(ghCall).not.toContain("'--repo'");
  });

  // --- boundary test (per #253 / Story 1.1 test-procedure ledger) ---

  test('execSync invocation matches gh CLI shape', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git\n');
    onExec(
      'gh pr comment 42',
      'https://github.com/org/repo/pull/42#issuecomment-1001\n',
    );

    await handler.execute({ number: 42, body: 'shape-check' });

    // Exactly one gh call (the comment, via the adapter's `runArgv` which
    // shell-escapes every token) and one git call (platform detect — the
    // adapter routing layer calls `detectPlatform()` which uses raw `execSync`
    // without shell-escape, hence the unquoted match).
    const ghCalls = execCalls.filter((c) => c.includes("'gh'"));
    expect(ghCalls.length).toBe(1);
    const gitCalls = execCalls.filter((c) => c.includes('git remote get-url'));
    expect(gitCalls.length).toBe(1);

    // The single gh call is fully shell-escaped: every token wrapped in '...'.
    expect(ghCalls[0]).toMatch(/^'gh' 'pr' 'comment' '42' '--body' 'shape-check'$/);
  });
});
