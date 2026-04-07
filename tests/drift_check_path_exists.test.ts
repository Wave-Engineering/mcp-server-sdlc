import { describe, test, expect, beforeEach, afterEach } from 'bun:test';

// Uses Bun.spawnSync('stat', ...) in the handler, so no module mocks.
// Tests operate on real files/directories in /tmp.

const { default: handler } = await import('../handlers/drift_check_path_exists.ts');

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

let fixtureDir = '';
const ORIGINAL_ENV = process.env.CLAUDE_PROJECT_DIR;

function restoreEnv() {
  if (ORIGINAL_ENV === undefined) {
    delete process.env.CLAUDE_PROJECT_DIR;
  } else {
    process.env.CLAUDE_PROJECT_DIR = ORIGINAL_ENV;
  }
}

async function setupProject(files: Record<string, string>) {
  fixtureDir = `/tmp/drift-path-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  for (const [name, content] of Object.entries(files)) {
    await Bun.write(`${fixtureDir}/${name}`, content);
  }
  process.env.CLAUDE_PROJECT_DIR = fixtureDir;
}

describe('drift_check_path_exists handler', () => {
  beforeEach(() => {
    fixtureDir = '';
  });
  afterEach(() => {
    fixtureDir = '';
    restoreEnv();
  });

  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('drift_check_path_exists');
    expect(typeof handler.execute).toBe('function');
  });

  test('file_exists — returns exists=true, actual_kind=file', async () => {
    await setupProject({ 'src/foo.ts': 'export const x = 1;' });
    const result = await handler.execute({ path: 'src/foo.ts' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.exists).toBe(true);
    expect(parsed.actual_kind).toBe('file');
  });

  test('file_missing — exists=false', async () => {
    await setupProject({ 'a.txt': 'hi' });
    const result = await handler.execute({ path: 'nonexistent.txt' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.exists).toBe(false);
    expect(parsed.actual_kind).toBe(null);
  });

  test('directory_exists_as_directory', async () => {
    await setupProject({ 'handlers/inner.ts': 'x' });
    const result = await handler.execute({ path: 'handlers', kind: 'directory' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.exists).toBe(true);
    expect(parsed.actual_kind).toBe('directory');
  });

  test('kind_mismatch — file exists but kind=directory → exists=false', async () => {
    await setupProject({ 'file.txt': 'hi' });
    const result = await handler.execute({ path: 'file.txt', kind: 'directory' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.exists).toBe(false);
    expect(parsed.actual_kind).toBe('file');
  });

  test('relative_path_anchoring — resolved against CLAUDE_PROJECT_DIR', async () => {
    await setupProject({ 'nested/deep/file.ts': 'x' });
    const result = await handler.execute({ path: 'nested/deep/file.ts' });
    const parsed = parseResult(result);
    expect(parsed.exists).toBe(true);
    expect(parsed.resolved).toContain(fixtureDir);
  });

  test('absolute_path_preserved', async () => {
    await setupProject({ 'a.txt': 'x' });
    const absPath = `${fixtureDir}/a.txt`;
    const result = await handler.execute({ path: absPath });
    const parsed = parseResult(result);
    expect(parsed.exists).toBe(true);
    expect(parsed.resolved).toBe(absPath);
  });

  test('schema_validation — rejects missing path', async () => {
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });

  test('schema_validation — rejects invalid kind', async () => {
    const result = await handler.execute({ path: 'x', kind: 'bogus' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });
});
