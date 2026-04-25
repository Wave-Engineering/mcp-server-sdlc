import { describe, test, expect, mock, beforeEach } from 'bun:test';

let execRegistry: Array<{ match: string; respond: string | (() => string) }> = [];
let execCalls: string[] = [];

interface MockExecError extends Error {
  stderr?: string;
  stdout?: string;
}

function mockExec(cmd: string): string {
  execCalls.push(cmd);
  for (const { match, respond } of execRegistry) {
    if (cmd.includes(match)) {
      return typeof respond === 'function' ? respond() : respond;
    }
  }
  throw new Error(`Unexpected exec call: ${cmd}`);
}

mock.module('child_process', () => ({
  execSync: (cmd: string, _opts?: unknown) => mockExec(cmd),
}));

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

  // ---- github happy path ----

  test('github — creates new label, returns created:true', async () => {
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

  test('github — quotes name and description with shell-escape', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git');
    onExec('gh label create', '');
    await handler.execute({
      name: "needs-review's-input",
      description: "It's important",
      color: 'd73a4a',
    });
    const createCall = execCalls.find((c) => c.includes('gh label create')) ?? '';
    expect(createCall).toContain(`'needs-review'\\''s-input'`);
    expect(createCall).toContain(`'It'\\''s important'`);
  });

  // ---- github idempotent path ----

  test('github — idempotent: duplicate triggers lookup, returns created:false', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git');
    onExec('gh label create', () => {
      const err: MockExecError = new Error('label already exists') as MockExecError;
      err.stderr = '! Label "bug" already exists\n';
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
      throw err;
    });
    const result = await handler.execute({ name: 'bug', color: 'd73a4a' });
    const data = parseResult(result.content);
    expect(data.ok).toBe(false);
    expect(String(data.error)).toContain('gh label create failed');
  });

  test('github — repo flag passed through to both create and lookup', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git');
    onExec('gh label create', '');
    await handler.execute({ name: 'bug', color: 'd73a4a', repo: 'foo/bar' });
    const createCall = execCalls.find((c) => c.includes('gh label create')) ?? '';
    expect(createCall).toContain("--repo 'foo/bar'");
  });

  // ---- gitlab happy path ----

  test('gitlab — creates new label, returns created:true', async () => {
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

  test('gitlab — uses --name (not positional) for label name', async () => {
    onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    onExec('glab label create', '');
    await handler.execute({ name: 'bug', color: 'd73a4a' });
    const createCall = execCalls.find((c) => c.includes('glab label create')) ?? '';
    expect(createCall).toContain("--name 'bug'");
  });

  test('gitlab — prepends `#` to color (GitLab REST API rejects bare hex)', async () => {
    onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    onExec('glab label create', '');
    await handler.execute({ name: 'bug', color: 'd73a4a' });
    const createCall = execCalls.find((c) => c.includes('glab label create')) ?? '';
    expect(createCall).toContain("--color '#d73a4a'");
    // Sanity: bare hex must NOT appear as a standalone color value (would
    // mean we forgot the # prepend).
    expect(createCall).not.toContain("--color 'd73a4a'");
  });

  test('github — passes color bare (gh accepts bare hex, no # prepend)', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git');
    onExec('gh label create', '');
    await handler.execute({ name: 'bug', color: 'd73a4a' });
    const createCall = execCalls.find((c) => c.includes('gh label create')) ?? '';
    expect(createCall).toContain("--color 'd73a4a'");
    expect(createCall).not.toContain("--color '#d73a4a'");
  });

  // ---- gitlab idempotent path ----

  test('gitlab — idempotent: duplicate triggers lookup, returns created:false', async () => {
    onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    onExec('glab label create', () => {
      const err: MockExecError = new Error('label already exists') as MockExecError;
      err.stderr = 'Label already exists\n';
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

  test('gitlab — repo flag uses -R (glab convention, not --repo)', async () => {
    onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git');
    onExec('glab label create', '');
    await handler.execute({ name: 'bug', color: 'd73a4a', repo: 'foo/bar' });
    const createCall = execCalls.find((c) => c.includes('glab label create')) ?? '';
    expect(createCall).toContain("-R 'foo/bar'");
  });

  // ---- color is optional ----

  test('color may be omitted', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git');
    onExec('gh label create', '');
    const result = await handler.execute({ name: 'bug' });
    const data = parseResult(result.content);
    expect(data.ok).toBe(true);
    const createCall = execCalls.find((c) => c.includes('gh label create')) ?? '';
    expect(createCall).not.toContain('--color');
  });

  // ---- duplicate detection regex ----

  test('"already exists" detection is case-insensitive', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git');
    onExec('gh label create', () => {
      const err: MockExecError = new Error('') as MockExecError;
      err.stderr = 'Label Already Exists in repo\n'; // mixed case
      throw err;
    });
    onExec('gh label list', JSON.stringify([{ name: 'bug', description: '', color: '' }]));
    const result = await handler.execute({ name: 'bug', color: 'd73a4a' });
    const data = parseResult(result.content);
    expect(data.ok).toBe(true);
    expect(data.created).toBe(false);
  });

  test('"already exists" detection also matches against stdout (some CLI versions)', async () => {
    onExec('git remote get-url origin', 'https://github.com/org/repo.git');
    onExec('gh label create', () => {
      const err: MockExecError = new Error('') as MockExecError;
      err.stdout = 'label already exists\n'; // on stdout, not stderr
      err.stderr = '';
      throw err;
    });
    onExec('gh label list', JSON.stringify([{ name: 'bug', description: '', color: '' }]));
    const result = await handler.execute({ name: 'bug', color: 'd73a4a' });
    const data = parseResult(result.content);
    expect(data.ok).toBe(true);
    expect(data.created).toBe(false);
  });
});
