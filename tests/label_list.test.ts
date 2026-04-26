import { describe, test, expect, mock, beforeEach } from 'bun:test';

// --- Mock child_process.execSync at module level ---
//
// label_list now dispatches through the platform adapter (Story 2.16 /
// #310). The per-platform adapters call subprocess via `runArgv`, which
// shell-escapes its argv (e.g. `'gh' 'label' 'list' '--limit' '100'`).
// The `unquote` shim strips that quoting so test match-keys can stay as plain
// `gh label list` strings — same pattern adopted by tests/label_create.test.ts.
//
// Integration coverage: schema validation, handler envelope shape, cross-platform
// dispatch (github → bare hex passthrough; gitlab → strip leading `#`).
//
// Subprocess-boundary argv assertions live in the colocated adapter tests
// (lib/adapters/label-list-{github,gitlab}.test.ts).

interface MockExecError extends Error {
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
  for (const { match, respond } of execRegistry) {
    if (cmd.includes(match) || flat.includes(match)) {
      return typeof respond === 'function' ? respond() : respond;
    }
  }
  throw new Error(`Unexpected exec: ${cmd}`);
});

mock.module('child_process', () => ({ execSync: mockExecSync }));

const { default: handler } = await import('../handlers/label_list.ts');

function parseResult(content: Array<{ type: string; text: string }>) {
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

function onExec(match: string, respond: string | (() => string)): void {
  execRegistry.push({ match, respond });
}

beforeEach(() => {
  execRegistry = [];
  execCalls = [];
});

describe('label_list handler', () => {
  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('label_list');
    expect(typeof handler.execute).toBe('function');
  });

  // ---- schema validation ----

  test('schema rejects malformed repo', async () => {
    const result = await handler.execute({ repo: 'not-a-slug' });
    const data = parseResult(result.content);
    expect(data.ok).toBe(false);
    expect(String(data.error)).toContain('owner/repo');
  });

  // ---- github end-to-end ----

  test('github — returns normalized labels from gh label list', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git');
    onExec('gh label list', JSON.stringify([
      { name: 'bug', description: 'Something broken', color: 'd73a4a' },
      { name: 'enhancement', description: 'New feature', color: 'a2eeef' },
    ]));
    const result = await handler.execute({});
    const data = parseResult(result.content);
    expect(data.ok).toBe(true);
    expect(data.count).toBe(2);
    const labels = data.labels as Array<{ name: string; color: string }>;
    expect(labels[0].name).toBe('bug');
    expect(labels[0].color).toBe('d73a4a');
  });

  test('github — default limit is 100 when not specified', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git');
    onExec('gh label list', '[]');
    await handler.execute({});
    // runArgv shell-escapes argv, so match against the unquoted form.
    const call = execCalls.find((c) => unquote(c).includes('gh label list')) ?? '';
    expect(call).toContain("'--limit' '100'");
  });

  test('github — returns ok:false on subprocess failure', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git');
    onExec('gh label list', () => {
      const err: MockExecError = new Error('gh not authenticated') as MockExecError;
      err.stderr = 'gh: not authenticated';
      err.status = 1;
      throw err;
    });
    const result = await handler.execute({});
    const data = parseResult(result.content);
    expect(data.ok).toBe(false);
    expect(String(data.error)).toContain('gh label list failed');
  });

  // ---- gitlab end-to-end ----

  test('gitlab — returns normalized labels and strips leading # from color', async () => {
    onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    onExec('glab label list', JSON.stringify([
      { name: 'bug', description: 'Bug', color: '#d73a4a' },
      { name: 'enhancement', color: '#a2eeef' }, // no description
    ]));
    const result = await handler.execute({});
    const data = parseResult(result.content);
    expect(data.ok).toBe(true);
    const labels = data.labels as Array<{ name: string; color: string; description: string }>;
    expect(labels[0].color).toBe('d73a4a'); // # stripped
    expect(labels[1].color).toBe('a2eeef');
    expect(labels[1].description).toBe(''); // missing → empty string
  });

  test('gitlab — forwards --per-page and -R (not --limit/--repo)', async () => {
    onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    onExec('glab label list', '[]');
    await handler.execute({ limit: 25, repo: 'foo/bar' });
    const call = execCalls.find((c) => unquote(c).includes('glab label list')) ?? '';
    expect(call).toContain("'--per-page' '25'");
    expect(call).toContain("'-R' 'foo/bar'");
    expect(call).toContain("'-F' 'json'");
  });
});
