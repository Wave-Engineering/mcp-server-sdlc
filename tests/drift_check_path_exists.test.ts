import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';

// drift_check_path_exists now uses child_process.execSync (story #253). Tests
// intercept the boundary via `mock.module('child_process', ...)`. Each test
// populates `execRegistry` with substring → responder mappings; an unmatched
// call throws so missing stubs surface loudly.

interface ThrowableError extends Error {
  stderr?: string;
  stdout?: string;
  status?: number;
}

type Responder = string | (() => string);

let execRegistry: Array<{ match: string; respond: Responder }> = [];
let execCalls: string[] = [];

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

const { default: handler } = await import('../handlers/drift_check_path_exists.ts');

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

function onExec(match: string, respond: Responder) {
  execRegistry.push({ match, respond });
}

function findCall(needle: string): string {
  return execCalls.find((c) => c.includes(needle) || unquote(c).includes(needle)) ?? '';
}

function failExec(match: string, stderr: string = 'No such file or directory', status: number = 1): void {
  onExec(match, () => {
    const err = new Error(stderr) as ThrowableError;
    err.stderr = stderr;
    err.stdout = '';
    err.status = status;
    throw err;
  });
}

const ORIGINAL_ENV = process.env.CLAUDE_PROJECT_DIR;
const FIXTURE_ROOT = '/tmp/drift-fixture-root';

function setProjectDir() {
  process.env.CLAUDE_PROJECT_DIR = FIXTURE_ROOT;
}

function restoreEnv() {
  if (ORIGINAL_ENV === undefined) {
    delete process.env.CLAUDE_PROJECT_DIR;
  } else {
    process.env.CLAUDE_PROJECT_DIR = ORIGINAL_ENV;
  }
}

beforeEach(() => {
  execRegistry = [];
  execCalls = [];
  setProjectDir();
});

afterEach(() => {
  execRegistry = [];
  execCalls = [];
  restoreEnv();
});

describe('drift_check_path_exists handler', () => {
  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('drift_check_path_exists');
    expect(typeof handler.execute).toBe('function');
  });

  test('file_exists — returns exists=true, actual_kind=file', async () => {
    onExec(`stat -c %F ${FIXTURE_ROOT}/src/foo.ts`, 'regular file\n');

    const result = await handler.execute({ path: 'src/foo.ts' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.exists).toBe(true);
    expect(parsed.actual_kind).toBe('file');
  });

  test('file_missing — exists=false', async () => {
    failExec(`stat -c %F ${FIXTURE_ROOT}/nonexistent.txt`);

    const result = await handler.execute({ path: 'nonexistent.txt' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.exists).toBe(false);
    expect(parsed.actual_kind).toBe(null);
  });

  test('directory_exists_as_directory', async () => {
    onExec(`stat -c %F ${FIXTURE_ROOT}/handlers`, 'directory\n');

    const result = await handler.execute({ path: 'handlers', kind: 'directory' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.exists).toBe(true);
    expect(parsed.actual_kind).toBe('directory');
  });

  test('kind_mismatch — file exists but kind=directory → exists=false', async () => {
    onExec(`stat -c %F ${FIXTURE_ROOT}/file.txt`, 'regular file\n');

    const result = await handler.execute({ path: 'file.txt', kind: 'directory' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.exists).toBe(false);
    // actual_kind reports what was found, even when the kind filter rejects it.
    expect(parsed.actual_kind).toBe('file');
  });

  test('relative_path_anchoring — resolved against CLAUDE_PROJECT_DIR', async () => {
    onExec(`stat -c %F ${FIXTURE_ROOT}/nested/deep/file.ts`, 'regular file\n');

    const result = await handler.execute({ path: 'nested/deep/file.ts' });
    const parsed = parseResult(result);
    expect(parsed.exists).toBe(true);
    expect(parsed.resolved).toBe(`${FIXTURE_ROOT}/nested/deep/file.ts`);
  });

  test('absolute_path_preserved', async () => {
    const absPath = '/tmp/some-absolute/file.txt';
    onExec(`stat -c %F ${absPath}`, 'regular file\n');

    const result = await handler.execute({ path: absPath });
    const parsed = parseResult(result);
    expect(parsed.exists).toBe(true);
    expect(parsed.resolved).toBe(absPath);
  });

  test('symbolic_link_reported_as_file', async () => {
    onExec(`stat -c %F ${FIXTURE_ROOT}/link`, 'symbolic link\n');

    const result = await handler.execute({ path: 'link' });
    const parsed = parseResult(result);
    expect(parsed.exists).toBe(true);
    // Per handler: anything not 'directory' falls into 'file' bucket.
    expect(parsed.actual_kind).toBe('file');
  });

  test('schema_validation — rejects missing path', async () => {
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    // No execSync should have been called.
    expect(execCalls.length).toBe(0);
  });

  test('schema_validation — rejects invalid kind', async () => {
    const result = await handler.execute({ path: 'x', kind: 'bogus' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(execCalls.length).toBe(0);
  });

  // --- boundary test (per #253 / Story 1.1 test-procedure ledger) ---

  test('execSync invocation matches stat CLI shape', async () => {
    onExec(`stat -c %F ${FIXTURE_ROOT}/probe.ts`, 'regular file\n');

    await handler.execute({ path: 'probe.ts' });

    expect(execCalls.length).toBe(1);
    // Fully shell-escaped: every token wrapped in '...'.
    expect(execCalls[0]).toMatch(
      new RegExp(`^'stat' '-c' '%F' '${FIXTURE_ROOT}/probe\\.ts'$`),
    );
  });
});
