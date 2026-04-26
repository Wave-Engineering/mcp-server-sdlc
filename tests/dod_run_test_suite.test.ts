import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';

// dod_run_test_suite now uses child_process.execSync for the actual command
// execution (story #253). Discovery still uses Bun.file (not subprocess) so it
// stays outside the mock surface and works against real fixture dirs.

interface ThrowableError extends Error {
  stderr?: string;
  stdout?: string;
  status?: number;
}

type Responder = string | (() => string);

let execRegistry: Array<{ match: string; respond: Responder }> = [];
let execCalls: string[] = [];

function mockExec(cmd: string): string {
  execCalls.push(cmd);
  for (const { match, respond } of execRegistry) {
    if (cmd.includes(match)) {
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

const { default: handler } = await import('../handlers/dod_run_test_suite.ts');

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

function onExec(match: string, respond: Responder) {
  execRegistry.push({ match, respond });
}

function failExec(match: string, stdout: string, status: number = 1): void {
  // For dod_run_test_suite the runner appends `2>&1`, so on failure the merged
  // stream lands in err.stdout (not err.stderr). Mirror that here.
  onExec(match, () => {
    const err = new Error('command failed') as ThrowableError;
    err.stdout = stdout;
    err.stderr = '';
    err.status = status;
    throw err;
  });
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

async function makeFixture(files: Record<string, string>): Promise<string> {
  const dir = `/tmp/dod-test-suite-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  for (const [name, content] of Object.entries(files)) {
    await Bun.write(`${dir}/${name}`, content);
  }
  return dir;
}

beforeEach(() => {
  execRegistry = [];
  execCalls = [];
  fixtureDir = '';
});

afterEach(() => {
  execRegistry = [];
  execCalls = [];
  fixtureDir = '';
  restoreEnv();
});

describe('dod_run_test_suite handler', () => {
  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('dod_run_test_suite');
    expect(typeof handler.execute).toBe('function');
  });

  test('explicit_command_override — input command bypasses discovery', async () => {
    fixtureDir = await makeFixture({
      'package.json': JSON.stringify({ scripts: { test: 'echo should-not-run' } }),
    });
    process.env.CLAUDE_PROJECT_DIR = fixtureDir;
    onExec('echo "1 passed, 0 failed"', '1 passed, 0 failed\n');

    const result = await handler.execute({ command: 'echo "1 passed, 0 failed"' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe('echo "1 passed, 0 failed"');
    expect(parsed.exit_code).toBe(0);
    expect(parsed.passed).toBe(1);
    expect(parsed.failed).toBe(0);

    // The override path means discovery never reached package.json's script.
    expect(execCalls.some((c) => c.includes('should-not-run'))).toBe(false);
  });

  test('discovers_scripts_ci_test — prefers scripts/ci/test.sh when present', async () => {
    fixtureDir = await makeFixture({
      'scripts/ci/test.sh': '#!/bin/sh\necho "5 pass\\n0 fail"\n',
      'package.json': JSON.stringify({ scripts: { test: 'should-not-see' } }),
    });
    // Discovery uses Bun.file().exists() — doesn't actually need execute bit.
    process.env.CLAUDE_PROJECT_DIR = fixtureDir;
    onExec('./scripts/ci/test.sh', '5 pass\n0 fail\n');

    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe('./scripts/ci/test.sh');
    expect(parsed.passed).toBe(5);
    expect(parsed.failed).toBe(0);
    // Discovery picked scripts/ci/test.sh, not the package.json fallback.
    expect(execCalls.some((c) => c.includes('npm test'))).toBe(false);
  });

  test('discovers_npm_test — falls back to npm test when only package.json present', async () => {
    fixtureDir = await makeFixture({
      'package.json': JSON.stringify({ scripts: { test: 'jest' } }),
    });
    process.env.CLAUDE_PROJECT_DIR = fixtureDir;
    onExec('npm test', '7 pass\n0 fail\n');

    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe('npm test');
    expect(parsed.passed).toBe(7);
  });

  test('discovers_pytest — uses pytest when only pyproject.toml present', async () => {
    fixtureDir = await makeFixture({ 'pyproject.toml': '[project]\nname="x"\n' });
    process.env.CLAUDE_PROJECT_DIR = fixtureDir;
    onExec('pytest', '===== 4 passed in 1s =====\n');

    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe('pytest');
    expect(parsed.passed).toBe(4);
  });

  test('parses_bun_test_output', async () => {
    fixtureDir = await makeFixture({ 'noop.txt': 'x' });
    process.env.CLAUDE_PROJECT_DIR = fixtureDir;
    onExec('bun test simulated', ' 42 pass\n 3 fail\n 1 skip\n');

    const result = await handler.execute({ command: 'bun test simulated' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.passed).toBe(42);
    expect(parsed.failed).toBe(3);
    expect(parsed.skipped).toBe(1);
  });

  test('parses_pytest_output', async () => {
    fixtureDir = await makeFixture({ 'noop.txt': 'x' });
    process.env.CLAUDE_PROJECT_DIR = fixtureDir;
    onExec(
      'pytest -q',
      '===== 10 passed, 2 failed, 1 skipped in 3.21s =====\n',
    );

    const result = await handler.execute({ command: 'pytest -q' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.passed).toBe(10);
    expect(parsed.failed).toBe(2);
    expect(parsed.skipped).toBe(1);
  });

  test('exit_code_nonzero_sets_failed — command fails, structured response not thrown', async () => {
    fixtureDir = await makeFixture({ 'noop.txt': 'x' });
    process.env.CLAUDE_PROJECT_DIR = fixtureDir;
    failExec('failing-tests', '0 passed, 5 failed\n', 1);

    const result = await handler.execute({ command: 'failing-tests' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.exit_code).not.toBe(0);
    expect(parsed.failed).toBe(5);
    expect(parsed.raw_output).toContain('0 passed, 5 failed');
  });

  test('no_test_command_found_returns_error', async () => {
    // A nonexistent root yields false from every Bun.file().exists() probe,
    // which is functionally identical to "exists but contains no manifest"
    // for the discovery code path. Skips the create-then-rm fixture dance.
    fixtureDir = `/tmp/dod-test-suite-empty-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    process.env.CLAUDE_PROJECT_DIR = fixtureDir;

    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('no test command found');
    // No subprocess should be invoked when discovery returns null.
    expect(execCalls.length).toBe(0);
  });

  // --- boundary test (per #253 / Story 1.1 test-procedure ledger) ---

  test('execSync invocation appends 2>&1 to merge stderr into stdout', async () => {
    fixtureDir = await makeFixture({ 'noop.txt': 'x' });
    process.env.CLAUDE_PROJECT_DIR = fixtureDir;
    onExec('shape-check-cmd', '1 pass\n');

    await handler.execute({ command: 'shape-check-cmd' });

    expect(execCalls.length).toBe(1);
    // The literal command + the 2>&1 redirect for merged-stream capture.
    expect(execCalls[0]).toBe('shape-check-cmd 2>&1');
  });
});
