import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';

interface ExecCall {
  cmd: string;
  opts: { cwd?: string; encoding?: string } | undefined;
}

let execCalls: ExecCall[] = [];
let execMockFn: (cmd: string, opts?: { cwd?: string }) => string = () => '';
const mockExecSync = mock((cmd: string, opts?: { cwd?: string; encoding?: string }) => {
  execCalls.push({ cmd, opts });
  return execMockFn(cmd, opts);
});
mock.module('child_process', () => ({ execSync: mockExecSync }));

const { default: handler } = await import('../handlers/devspec_locate.ts');

const ORIGINAL_ENV = process.env.CLAUDE_PROJECT_DIR;

function resetMocks() {
  execCalls = [];
  execMockFn = () => '';
  mockExecSync.mockClear();
}

function restoreEnv() {
  if (ORIGINAL_ENV === undefined) {
    delete process.env.CLAUDE_PROJECT_DIR;
  } else {
    process.env.CLAUDE_PROJECT_DIR = ORIGINAL_ENV;
  }
}

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

/**
 * Build a fake execSync that recognizes the handler's three command shapes:
 *   1. `test -d '<root>'`           — root existence
 *   2. `test -d '<root>/docs'`      — docs existence
 *   3. `find docs -maxdepth 1 ...`  — list devspec files
 *
 * Callers configure which directories "exist" and what the find output is.
 */
function buildExec(opts: {
  rootExists: boolean;
  docsExists: boolean;
  findOutput: string;
}) {
  return (cmd: string) => {
    if (cmd.startsWith('test -d')) {
      // Second test -d targets path ending with /docs
      if (/\/docs'?$/.test(cmd)) {
        if (!opts.docsExists) throw new Error('docs missing');
        return '';
      }
      if (!opts.rootExists) throw new Error('root missing');
      return '';
    }
    if (cmd.startsWith('find docs')) {
      return opts.findOutput;
    }
    return '';
  };
}

describe('devspec_locate handler', () => {
  beforeEach(() => {
    resetMocks();
    delete process.env.CLAUDE_PROJECT_DIR;
  });
  afterEach(() => {
    resetMocks();
    restoreEnv();
  });

  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('devspec_locate');
    expect(typeof handler.execute).toBe('function');
  });

  test('finds single devspec file', async () => {
    execMockFn = buildExec({
      rootExists: true,
      docsExists: true,
      findOutput: 'docs/alpha-devspec.md\n',
    });
    const result = await handler.execute({ root: '/tmp/proj' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.files).toEqual(['docs/alpha-devspec.md']);
    expect(parsed.count).toBe(1);
  });

  test('finds and sorts multiple devspec files', async () => {
    execMockFn = buildExec({
      rootExists: true,
      docsExists: true,
      // Deliberately unsorted to prove the handler sorts.
      findOutput: 'docs/charlie-devspec.md\ndocs/alpha-devspec.md\ndocs/bravo-devspec.md\n',
    });
    const result = await handler.execute({ root: '/tmp/proj' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.files).toEqual([
      'docs/alpha-devspec.md',
      'docs/bravo-devspec.md',
      'docs/charlie-devspec.md',
    ]);
    expect(parsed.count).toBe(3);
  });

  test('returns empty list when none exist', async () => {
    execMockFn = buildExec({
      rootExists: true,
      docsExists: true,
      findOutput: '',
    });
    const result = await handler.execute({ root: '/tmp/proj' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.files).toEqual([]);
    expect(parsed.count).toBe(0);
  });

  test('handles missing docs/ directory — not an error', async () => {
    execMockFn = buildExec({
      rootExists: true,
      docsExists: false,
      findOutput: '',
    });
    const result = await handler.execute({ root: '/tmp/proj' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.files).toEqual([]);
    expect(parsed.count).toBe(0);
    // find should NOT have been called when docs/ is missing.
    const findCalls = execCalls.filter(c => c.cmd.startsWith('find docs'));
    expect(findCalls.length).toBe(0);
  });

  test('errors on nonexistent root', async () => {
    execMockFn = buildExec({
      rootExists: false,
      docsExists: false,
      findOutput: '',
    });
    const result = await handler.execute({ root: '/tmp/nonexistent' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('/tmp/nonexistent');
  });

  test('uses CLAUDE_PROJECT_DIR when root param omitted', async () => {
    process.env.CLAUDE_PROJECT_DIR = '/tmp/env-root';
    execMockFn = buildExec({
      rootExists: true,
      docsExists: true,
      findOutput: 'docs/env-devspec.md\n',
    });
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.files).toEqual(['docs/env-devspec.md']);
    // find should have been invoked with cwd=/tmp/env-root
    const findCall = execCalls.find(c => c.cmd.startsWith('find docs'));
    expect(findCall?.opts?.cwd).toBe('/tmp/env-root');
  });

  test('explicit root param takes precedence over CLAUDE_PROJECT_DIR', async () => {
    process.env.CLAUDE_PROJECT_DIR = '/tmp/env-root';
    execMockFn = buildExec({
      rootExists: true,
      docsExists: true,
      findOutput: 'docs/explicit-devspec.md\n',
    });
    await handler.execute({ root: '/tmp/explicit' });
    const findCall = execCalls.find(c => c.cmd.startsWith('find docs'));
    expect(findCall?.opts?.cwd).toBe('/tmp/explicit');
  });

  test('find is invoked with correct glob pattern', async () => {
    execMockFn = buildExec({
      rootExists: true,
      docsExists: true,
      findOutput: '',
    });
    await handler.execute({ root: '/tmp/proj' });
    const findCall = execCalls.find(c => c.cmd.startsWith('find docs'));
    expect(findCall?.cmd).toContain('-maxdepth 1');
    expect(findCall?.cmd).toContain(`-name '*-devspec.md'`);
  });
});
