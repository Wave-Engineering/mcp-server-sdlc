import { describe, test, expect, beforeEach, afterEach } from 'bun:test';

// This handler uses Bun.spawnSync + Bun.file (native APIs), so tests
// work against real tempdirs and real shell commands. No module mocks.

const { default: handler } = await import('../handlers/dod_run_test_suite.ts');

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

async function makeFixture(files: Record<string, string>): Promise<string> {
  const dir = `/tmp/dod-test-suite-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  for (const [name, content] of Object.entries(files)) {
    await Bun.write(`${dir}/${name}`, content);
  }
  return dir;
}

describe('dod_run_test_suite handler', () => {
  beforeEach(() => {
    fixtureDir = '';
  });
  afterEach(() => {
    fixtureDir = '';
    restoreEnv();
  });

  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('dod_run_test_suite');
    expect(typeof handler.execute).toBe('function');
  });

  test('explicit_command_override — input command bypasses discovery', async () => {
    fixtureDir = await makeFixture({
      'package.json': JSON.stringify({ scripts: { test: 'echo should-not-run' } }),
    });
    process.env.CLAUDE_PROJECT_DIR = fixtureDir;
    const result = await handler.execute({ command: 'echo "1 passed, 0 failed"' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe('echo "1 passed, 0 failed"');
    expect(parsed.exit_code).toBe(0);
    expect(parsed.passed).toBe(1);
    expect(parsed.failed).toBe(0);
  });

  test('discovers_scripts_ci_test — prefers scripts/ci/test.sh when present', async () => {
    fixtureDir = await makeFixture({
      'scripts/ci/test.sh': '#!/bin/sh\necho "5 pass\\n0 fail"\n',
      'package.json': JSON.stringify({ scripts: { test: 'should-not-see' } }),
    });
    // Make it executable.
    Bun.spawnSync({ cmd: ['chmod', '+x', `${fixtureDir}/scripts/ci/test.sh`] });
    process.env.CLAUDE_PROJECT_DIR = fixtureDir;
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe('./scripts/ci/test.sh');
  });

  test('parses_bun_test_output', async () => {
    fixtureDir = await makeFixture({ 'noop.txt': 'x' });
    process.env.CLAUDE_PROJECT_DIR = fixtureDir;
    const result = await handler.execute({
      command: 'echo " 42 pass\\n 3 fail\\n 1 skip"',
    });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.passed).toBe(42);
    expect(parsed.failed).toBe(3);
    expect(parsed.skipped).toBe(1);
  });

  test('parses_pytest_output', async () => {
    fixtureDir = await makeFixture({ 'noop.txt': 'x' });
    process.env.CLAUDE_PROJECT_DIR = fixtureDir;
    const result = await handler.execute({
      command: 'echo "===== 10 passed, 2 failed, 1 skipped in 3.21s ====="',
    });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.passed).toBe(10);
    expect(parsed.failed).toBe(2);
    expect(parsed.skipped).toBe(1);
  });

  test('exit_code_nonzero_sets_failed — command fails, structured response not thrown', async () => {
    fixtureDir = await makeFixture({ 'noop.txt': 'x' });
    process.env.CLAUDE_PROJECT_DIR = fixtureDir;
    const result = await handler.execute({
      command: 'sh -c "echo \\"0 passed, 5 failed\\"; exit 1"',
    });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.exit_code).not.toBe(0);
    expect(parsed.failed).toBe(5);
  });

  test('no_test_command_found_returns_error', async () => {
    fixtureDir = `/tmp/dod-test-suite-empty-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    // Ensure dir exists.
    await Bun.write(`${fixtureDir}/.keep`, '');
    Bun.spawnSync({ cmd: ['rm', `${fixtureDir}/.keep`] });
    process.env.CLAUDE_PROJECT_DIR = fixtureDir;
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('no test command found');
  });
});
