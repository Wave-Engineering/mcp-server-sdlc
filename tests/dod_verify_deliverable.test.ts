import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';

// dod_verify_deliverable now uses child_process.execSync (story #253). Tests
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

const { default: handler } = await import('../handlers/dod_verify_deliverable.ts');

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

function onExec(match: string, respond: Responder) {
  execRegistry.push({ match, respond });
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

beforeEach(() => {
  execRegistry = [];
  execCalls = [];
});

afterEach(() => {
  execRegistry = [];
  execCalls = [];
});

describe('dod_verify_deliverable handler', () => {
  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('dod_verify_deliverable');
    expect(typeof handler.execute).toBe('function');
  });

  test('existing_file — returns exists=true, empty=false, size>0', async () => {
    const path = '/tmp/dod-evidence-1.txt';
    // mtime: 1700000000s → 2023-11-14T22:13:20.000Z
    onExec(`stat -c %F|%s|%Y ${path}`, 'regular file|123|1700000000\n');

    const result = await handler.execute({ id: 'D-01', evidence_path: path });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.exists).toBe(true);
    expect(parsed.empty).toBe(false);
    expect(parsed.size_bytes).toBe(123);
    expect(parsed.is_directory).toBe(false);
    expect(parsed.id).toBe('D-01');
    expect(parsed.last_modified).toBe('2023-11-14T22:13:20.000Z');
  });

  test('existing_empty_file — exists=true, empty=true, size=0', async () => {
    const path = '/tmp/dod-evidence-empty.txt';
    onExec(`stat -c %F|%s|%Y ${path}`, 'regular file|0|1700000000\n');

    const result = await handler.execute({ id: 'D-02', evidence_path: path });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.exists).toBe(true);
    expect(parsed.empty).toBe(true);
    expect(parsed.size_bytes).toBe(0);
    expect(parsed.is_directory).toBe(false);
  });

  test('missing_path — exists=false, empty=true', async () => {
    const path = '/tmp/definitely-nonexistent-path-xyz-987654321';
    failExec(`stat -c %F|%s|%Y ${path}`);

    const result = await handler.execute({ id: 'D-03', evidence_path: path });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.exists).toBe(false);
    expect(parsed.empty).toBe(true);
    expect(parsed.size_bytes).toBe(0);
    expect(parsed.last_modified).toBe(null);
  });

  test('directory_with_contents — is_directory=true, empty=false', async () => {
    const path = '/tmp/dod-dir-with-files';
    onExec(`stat -c %F|%s|%Y ${path}`, 'directory|4096|1700000000\n');
    onExec(`ls -A ${path}`, 'inner.txt\nsibling.md\n');

    const result = await handler.execute({ id: 'D-04', evidence_path: path });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.exists).toBe(true);
    expect(parsed.is_directory).toBe(true);
    expect(parsed.empty).toBe(false);
  });

  test('empty_directory — is_directory=true, empty=true', async () => {
    const path = '/tmp/dod-empty-dir';
    onExec(`stat -c %F|%s|%Y ${path}`, 'directory|4096|1700000000\n');
    onExec(`ls -A ${path}`, '\n');

    const result = await handler.execute({ id: 'D-05', evidence_path: path });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.exists).toBe(true);
    expect(parsed.is_directory).toBe(true);
    expect(parsed.empty).toBe(true);
  });

  test('directory_with_failed_ls — preserves original semantics: empty=true', async () => {
    // Original handler swallows ls errors and treats as empty. Preserved post-refactor.
    const path = '/tmp/dod-perm-denied';
    onExec(`stat -c %F|%s|%Y ${path}`, 'directory|4096|1700000000\n');
    failExec(`ls -A ${path}`, 'Permission denied');

    const result = await handler.execute({ id: 'D-06', evidence_path: path });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.exists).toBe(true);
    expect(parsed.is_directory).toBe(true);
    expect(parsed.empty).toBe(true);
  });

  test('schema_validation — rejects missing id', async () => {
    const result = await handler.execute({ evidence_path: '/tmp/x' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(execCalls.length).toBe(0);
  });

  test('schema_validation — rejects missing evidence_path', async () => {
    const result = await handler.execute({ id: 'D-01' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(execCalls.length).toBe(0);
  });

  // --- boundary test (per #253 / Story 1.1 test-procedure ledger) ---

  test('execSync invocation matches stat CLI shape (file path)', async () => {
    const path = '/tmp/shape-check';
    onExec(`stat -c %F|%s|%Y ${path}`, 'regular file|10|1700000000\n');

    await handler.execute({ id: 'D-X', evidence_path: path });

    expect(execCalls.length).toBe(1);
    expect(execCalls[0]).toBe(`'stat' '-c' '%F|%s|%Y' '${path}'`);
  });

  test('execSync invocation matches ls CLI shape (directory path)', async () => {
    const path = '/tmp/shape-check-dir';
    onExec(`stat -c %F|%s|%Y ${path}`, 'directory|4096|1700000000\n');
    onExec(`ls -A ${path}`, 'a\n');

    await handler.execute({ id: 'D-X', evidence_path: path });

    expect(execCalls.length).toBe(2);
    expect(execCalls[0]).toBe(`'stat' '-c' '%F|%s|%Y' '${path}'`);
    expect(execCalls[1]).toBe(`'ls' '-A' '${path}'`);
  });
});
