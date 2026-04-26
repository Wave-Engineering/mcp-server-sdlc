import { describe, test, expect, mock, beforeEach } from 'bun:test';

// --- Mock child_process.execSync at module level ---
//
// label_create now dispatches through the platform adapter (Story 2.15 /
// #309). The per-platform adapters call subprocess via `runArgv`, which
// shell-escapes its argv (e.g. `'gh' 'label' 'create' 'bug' '--color' 'd73a4a'`).
// The `unquote` shim strips that quoting so test match-keys can stay as plain
// `gh label create ...` strings — same pattern adopted by tests/ci_failed_jobs.test.ts.
//
// Integration coverage: schema validation, handler envelope shape, cross-platform
// dispatch (github → bare hex; gitlab → leading `#`), idempotent fallback
// (duplicate → lookup → created:false).
//
// Subprocess-boundary argv assertions live in the colocated adapter tests
// (lib/adapters/label-create-{github,gitlab}.test.ts).

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

const { default: handler } = await import('../handlers/label_create.ts');

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

describe('label_create handler', () => {
  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('label_create');
    expect(typeof handler.execute).toBe('function');
  });

  // ---- schema validation ----

  test('schema rejects missing name', async () => {
    const result = await handler.execute({ color: 'd73a4a' });
    const data = parseResult(result.content);
    expect(data.ok).toBe(false);
  });

  test('schema rejects color with leading # (must be bare hex)', async () => {
    const result = await handler.execute({ name: 'bug', color: '#d73a4a' });
    const data = parseResult(result.content);
    expect(data.ok).toBe(false);
    expect(String(data.error)).toContain('hex');
  });

  test('schema accepts uppercase hex color', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git');
    onExec('gh label create', '');
    const result = await handler.execute({ name: 'bug', color: 'D73A4A' });
    const data = parseResult(result.content);
    expect(data.ok).toBe(true);
  });

  test('schema rejects malformed repo', async () => {
    const result = await handler.execute({ name: 'bug', repo: 'not-a-slug' });
    const data = parseResult(result.content);
    expect(data.ok).toBe(false);
  });

  // ---- github end-to-end ----

  test('github_end_to_end — creates new label, returns created:true', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git');
    onExec('gh label create', '');
    const result = await handler.execute({
      name: 'priority::high',
      description: 'Top priority',
      color: 'd73a4a',
    });
    const data = parseResult(result.content);
    expect(data.ok).toBe(true);
    expect(data.created).toBe(true);
    expect(data.name).toBe('priority::high');
    expect(data.color).toBe('d73a4a');
    expect(data.description).toBe('Top priority');
  });

  test('github — idempotent: duplicate triggers lookup, returns created:false', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git');
    onExec('gh label create', () => {
      const err: MockExecError = new Error('label already exists') as MockExecError;
      err.stderr = '! Label "bug" already exists\n';
      err.status = 1;
      throw err;
    });
    onExec('gh label list', JSON.stringify([
      { name: 'bug', description: 'pre-existing', color: 'aabbcc' },
    ]));
    const result = await handler.execute({
      name: 'bug',
      description: 'requested description (will be ignored — label already exists)',
      color: 'd73a4a',
    });
    const data = parseResult(result.content);
    expect(data.ok).toBe(true);
    expect(data.created).toBe(false);
    expect(data.name).toBe('bug');
    // Returned values reflect what's already on the platform, not what we asked for
    expect(data.description).toBe('pre-existing');
    expect(data.color).toBe('aabbcc');
  });

  test('github — non-duplicate failure surfaces ok:false', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git');
    onExec('gh label create', () => {
      const err: MockExecError = new Error('auth required') as MockExecError;
      err.stderr = 'gh: not authenticated\n';
      err.status = 1;
      throw err;
    });
    const result = await handler.execute({ name: 'bug', color: 'd73a4a' });
    const data = parseResult(result.content);
    expect(data.ok).toBe(false);
    expect(String(data.error)).toContain('gh label create failed');
  });

  // ---- gitlab end-to-end ----

  test('gitlab_end_to_end — creates new label, returns created:true', async () => {
    onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    onExec('glab label create', '');
    const result = await handler.execute({
      name: 'priority::high',
      description: 'Top priority',
      color: 'd73a4a',
    });
    const data = parseResult(result.content);
    expect(data.ok).toBe(true);
    expect(data.created).toBe(true);
    expect(data.name).toBe('priority::high');
  });

  test('gitlab — idempotent: duplicate triggers lookup, returns created:false', async () => {
    onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    onExec('glab label create', () => {
      const err: MockExecError = new Error('label already exists') as MockExecError;
      err.stderr = 'Label already exists\n';
      err.status = 1;
      throw err;
    });
    onExec('glab label list', JSON.stringify([
      { name: 'bug', description: 'pre-existing', color: '#aabbcc' },
    ]));
    const result = await handler.execute({
      name: 'bug',
      description: 'ignored',
      color: 'd73a4a',
    });
    const data = parseResult(result.content);
    expect(data.ok).toBe(true);
    expect(data.created).toBe(false);
    expect(data.color).toBe('aabbcc'); // # stripped
  });

  // ---- color is optional ----

  test('color may be omitted', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git');
    onExec('gh label create', '');
    const result = await handler.execute({ name: 'bug' });
    const data = parseResult(result.content);
    expect(data.ok).toBe(true);
  });
});
