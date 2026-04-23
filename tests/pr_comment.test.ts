import { describe, test, expect, beforeEach, afterEach } from 'bun:test';

// This handler uses Bun.spawnSync directly (no child_process, no node:fs),
// so tests run against real fixture shell scripts placed on a scoped PATH.
// No module mocks.

const { default: handler } = await import('../handlers/pr_comment.ts');

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR;

let fixtureDir = '';

function restoreEnv() {
  process.env.PATH = ORIGINAL_PATH;
  if (ORIGINAL_PROJECT_DIR === undefined) {
    delete process.env.CLAUDE_PROJECT_DIR;
  } else {
    process.env.CLAUDE_PROJECT_DIR = ORIGINAL_PROJECT_DIR;
  }
}

/**
 * Build a fixture directory with:
 *   - bin/gh, bin/glab, bin/git shell scripts (made executable)
 *   - a dummy working tree
 * Returns the absolute fixture path and updates PATH + CLAUDE_PROJECT_DIR.
 *
 * The shell scripts log their invocations to `bin/.calls` (one JSON line each)
 * so tests can assert the exact body the handler passed via argv.
 */
async function makeFixture(bins: Record<string, string>): Promise<string> {
  const dir = `/tmp/pr-comment-test-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  await Bun.write(`${dir}/.keep`, '');
  for (const [name, script] of Object.entries(bins)) {
    const path = `${dir}/bin/${name}`;
    await Bun.write(path, script);
    Bun.spawnSync({ cmd: ['chmod', '+x', path] });
  }
  process.env.PATH = `${dir}/bin:${ORIGINAL_PATH}`;
  process.env.CLAUDE_PROJECT_DIR = dir;
  return dir;
}

/**
 * A fake `git` that answers `git remote get-url origin` with the given URL
 * and errors on anything else. Used to steer platform detection.
 */
function fakeGit(originUrl: string): string {
  return `#!/bin/sh
if [ "$1" = "remote" ] && [ "$2" = "get-url" ] && [ "$3" = "origin" ]; then
  echo "${originUrl}"
  exit 0
fi
echo "unexpected git call: $*" >&2
exit 1
`;
}

/**
 * A fake `gh` that records its argv to $FIXTURE/bin/.calls and prints a
 * canned URL so the handler can parse the comment ID. The PR number and
 * comment ID come from env so each test can customize them.
 */
function fakeGh(prNum: number, commentId: number): string {
  // Record args separated by \x1f (unit separator), calls separated by \x1e
  // (record separator) — neither collides with markdown content.
  return `#!/bin/sh
{
  printf '\\036'
  first=1
  for a in "$@"; do
    if [ $first -eq 1 ]; then
      first=0
    else
      printf '\\037'
    fi
    printf '%s' "$a"
  done
} >> "$(dirname "$0")/.calls"

if [ "$1" = "pr" ] && [ "$2" = "comment" ]; then
  echo "https://github.com/org/repo/pull/${prNum}#issuecomment-${commentId}"
  exit 0
fi
echo "unexpected gh call" >&2
exit 1
`;
}

/**
 * A fake `glab` that records its argv and prints a canned MR note URL.
 */
function fakeGlab(mrNum: number, noteId: number): string {
  return `#!/bin/sh
{
  printf '\\036'
  first=1
  for a in "$@"; do
    if [ $first -eq 1 ]; then
      first=0
    else
      printf '\\037'
    fi
    printf '%s' "$a"
  done
} >> "$(dirname "$0")/.calls"

if [ "$1" = "mr" ] && [ "$2" = "note" ]; then
  echo "https://gitlab.com/org/repo/-/merge_requests/${mrNum}#note_${noteId}"
  exit 0
fi
echo "unexpected glab call" >&2
exit 1
`;
}

async function readCalls(dir: string): Promise<string[][]> {
  const file = Bun.file(`${dir}/bin/.calls`);
  if (!(await file.exists())) return [];
  const text = await file.text();
  // Records separated by \x1e, fields within a record by \x1f.
  return text
    .split('\x1e')
    .filter((rec) => rec.length > 0)
    .map((rec) => rec.split('\x1f'));
}

describe('pr_comment handler', () => {
  beforeEach(() => {
    fixtureDir = '';
  });
  afterEach(() => {
    fixtureDir = '';
    restoreEnv();
  });

  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('pr_comment');
    expect(typeof handler.execute).toBe('function');
    expect(handler.description.length).toBeGreaterThan(0);
  });

  test('rejects missing number', async () => {
    fixtureDir = await makeFixture({
      git: fakeGit('https://github.com/org/repo.git'),
      gh: fakeGh(1, 1),
    });
    const result = await handler.execute({ body: 'hi' });
    const data = parseResult(result);
    expect(data.ok).toBe(false);
  });

  test('rejects empty body', async () => {
    fixtureDir = await makeFixture({
      git: fakeGit('https://github.com/org/repo.git'),
      gh: fakeGh(1, 1),
    });
    const result = await handler.execute({ number: 12, body: '' });
    const data = parseResult(result);
    expect(data.ok).toBe(false);
    expect((data.error as string)).toContain('body');
  });

  test('github — plain text comment returns numeric comment_id and url', async () => {
    fixtureDir = await makeFixture({
      git: fakeGit('https://github.com/org/repo.git'),
      gh: fakeGh(42, 1001),
    });

    const result = await handler.execute({ number: 42, body: 'looks good' });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.number).toBe(42);
    expect(data.comment_id).toBe(1001);
    expect(data.url).toBe('https://github.com/org/repo/pull/42#issuecomment-1001');

    const calls = await readCalls(fixtureDir);
    // One git call (platform detect) + one gh call (comment)
    const ghCall = calls.find((c) => c[0] === 'pr' && c[1] === 'comment');
    expect(ghCall).toBeDefined();
    expect(ghCall).toEqual(['pr', 'comment', '42', '--body', 'looks good']);
  });

  test('github — markdown body (code fence, bold, link, list) round-trips verbatim', async () => {
    fixtureDir = await makeFixture({
      git: fakeGit('git@github.com:org/repo.git'),
      gh: fakeGh(7, 2002),
    });

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

    const calls = await readCalls(fixtureDir);
    const ghCall = calls.find((c) => c[0] === 'pr' && c[1] === 'comment');
    expect(ghCall).toBeDefined();
    // The 5th arg is the full body — assert verbatim preservation.
    expect(ghCall?.[4]).toBe(body);
  });

  test('github — unicode and emoji body preserved verbatim', async () => {
    fixtureDir = await makeFixture({
      git: fakeGit('https://github.com/org/repo.git'),
      gh: fakeGh(3, 3003),
    });

    const body = 'LGTM — 🚀 中文 тест αβγ';

    const result = await handler.execute({ number: 3, body });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.comment_id).toBe(3003);

    const calls = await readCalls(fixtureDir);
    const ghCall = calls.find((c) => c[0] === 'pr' && c[1] === 'comment');
    expect(ghCall?.[4]).toBe(body);
  });

  test('gitlab — plain text comment returns numeric comment_id and url', async () => {
    fixtureDir = await makeFixture({
      git: fakeGit('https://gitlab.com/org/repo.git'),
      glab: fakeGlab(55, 9090),
    });

    const result = await handler.execute({ number: 55, body: 'ship it' });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.number).toBe(55);
    expect(data.comment_id).toBe(9090);
    expect(data.url).toBe('https://gitlab.com/org/repo/-/merge_requests/55#note_9090');

    const calls = await readCalls(fixtureDir);
    const glabCall = calls.find((c) => c[0] === 'mr' && c[1] === 'note');
    expect(glabCall).toEqual(['mr', 'note', '55', '--message', 'ship it']);
  });

  test('gitlab — markdown body with code fence preserved verbatim', async () => {
    fixtureDir = await makeFixture({
      git: fakeGit('git@gitlab.com:org/repo.git'),
      glab: fakeGlab(88, 7070),
    });

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

    const calls = await readCalls(fixtureDir);
    const glabCall = calls.find((c) => c[0] === 'mr' && c[1] === 'note');
    expect(glabCall?.[4]).toBe(body);
  });

  test('gitlab — unicode body preserved', async () => {
    fixtureDir = await makeFixture({
      git: fakeGit('https://gitlab.example.com/team/proj.git'),
      glab: fakeGlab(11, 2222),
    });

    const body = '✅ passed: 42 ❌ failed: 0 — 完了';

    const result = await handler.execute({ number: 11, body });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.comment_id).toBe(2222);

    const calls = await readCalls(fixtureDir);
    const glabCall = calls.find((c) => c[0] === 'mr' && c[1] === 'note');
    expect(glabCall?.[4]).toBe(body);
  });

  test('github — gh failure is returned as structured error, not thrown', async () => {
    fixtureDir = await makeFixture({
      git: fakeGit('https://github.com/org/repo.git'),
      gh: `#!/bin/sh
echo "HTTP 404: Not Found" >&2
exit 1
`,
    });

    const result = await handler.execute({ number: 9999, body: 'nope' });
    const data = parseResult(result);

    expect(data.ok).toBe(false);
    expect((data.error as string)).toContain('gh pr comment failed');
  });

  test('github — unparseable stdout (no issuecomment id) returns structured error', async () => {
    fixtureDir = await makeFixture({
      git: fakeGit('https://github.com/org/repo.git'),
      gh: `#!/bin/sh
echo "posted comment ok"
exit 0
`,
    });

    const result = await handler.execute({ number: 1, body: 'x' });
    const data = parseResult(result);

    expect(data.ok).toBe(false);
    expect((data.error as string)).toContain('failed to parse comment ID');
  });

  // --- cross-repo routing ---

  test('route_with_repo — github appends --repo and slug to gh argv', async () => {
    // cwd remote is a DIFFERENT repo than the target.
    fixtureDir = await makeFixture({
      git: fakeGit('https://github.com/cwd-org/cwd-repo.git'),
      gh: fakeGh(42, 1001),
    });

    const result = await handler.execute({
      number: 42,
      body: 'cross-repo comment',
      repo: 'Wave-Engineering/mcp-server-sdlc',
    });
    const data = parseResult(result);
    expect(data.ok).toBe(true);

    const calls = await readCalls(fixtureDir);
    const ghCall = calls.find((c) => c[0] === 'pr' && c[1] === 'comment');
    expect(ghCall).toBeDefined();
    expect(ghCall).toContain('--repo');
    expect(ghCall).toContain('Wave-Engineering/mcp-server-sdlc');
  });

  test('route_with_repo — gitlab appends -R and slug to glab argv', async () => {
    fixtureDir = await makeFixture({
      git: fakeGit('https://gitlab.com/cwd-org/cwd-repo.git'),
      glab: fakeGlab(55, 9090),
    });

    const result = await handler.execute({
      number: 55,
      body: 'cross-repo note',
      repo: 'target-org/target-repo',
    });
    const data = parseResult(result);
    expect(data.ok).toBe(true);

    const calls = await readCalls(fixtureDir);
    const glabCall = calls.find((c) => c[0] === 'mr' && c[1] === 'note');
    expect(glabCall).toBeDefined();
    expect(glabCall).toContain('-R');
    expect(glabCall).toContain('target-org/target-repo');
  });

  test('regression_without_repo — gh argv does NOT contain --repo', async () => {
    fixtureDir = await makeFixture({
      git: fakeGit('https://github.com/org/repo.git'),
      gh: fakeGh(42, 1001),
    });

    const result = await handler.execute({ number: 42, body: 'hi' });
    const data = parseResult(result);
    expect(data.ok).toBe(true);

    const calls = await readCalls(fixtureDir);
    const ghCall = calls.find((c) => c[0] === 'pr' && c[1] === 'comment');
    expect(ghCall).toBeDefined();
    expect(ghCall).not.toContain('--repo');
  });

  test('invalid_slug_early_error — returns ok:false without spawning gh/glab', async () => {
    // Fixture has no gh/glab stubs — any spawn attempt would fail with a
    // different error. Empty bin dir; only git stub present (which shouldn't
    // even be reached because zod rejects first).
    const dir = `/tmp/pr-comment-invalid-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    await Bun.write(`${dir}/.keep`, '');
    await Bun.write(`${dir}/bin/.keep`, '');
    process.env.PATH = `${dir}/bin:${ORIGINAL_PATH}`;
    process.env.CLAUDE_PROJECT_DIR = dir;
    fixtureDir = dir;

    const result = await handler.execute({
      number: 1,
      body: 'x',
      repo: 'not-a-slug',
    });
    const data = parseResult(result);
    expect(data.ok).toBe(false);
    expect(String(data.error)).toContain('repo');

    // Calls file should not exist (no gh/glab was spawned).
    const callsFile = Bun.file(`${dir}/bin/.calls`);
    expect(await callsFile.exists()).toBe(false);
  });
});
