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

const { default: handler } = await import('../handlers/ddd_locate_domain_model.ts');

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

function buildExec(opts: { rootExists: boolean; modelExists: boolean }) {
  return (cmd: string) => {
    if (cmd.startsWith('test -d')) {
      if (!opts.rootExists) throw new Error('root missing');
      return '';
    }
    if (cmd.startsWith('test -f')) {
      if (!opts.modelExists) throw new Error('model missing');
      return '';
    }
    return '';
  };
}

describe('ddd_locate_domain_model handler', () => {
  beforeEach(() => {
    resetMocks();
    delete process.env.CLAUDE_PROJECT_DIR;
  });
  afterEach(() => {
    resetMocks();
    restoreEnv();
  });

  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('ddd_locate_domain_model');
    expect(typeof handler.execute).toBe('function');
  });

  test('finds existing domain model', async () => {
    execMockFn = buildExec({ rootExists: true, modelExists: true });
    const result = await handler.execute({ root: '/tmp/proj' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.exists).toBe(true);
    expect(parsed.path).toBe('/tmp/proj/docs/DOMAIN-MODEL.md');
  });

  test('returns exists:false when domain model missing', async () => {
    execMockFn = buildExec({ rootExists: true, modelExists: false });
    const result = await handler.execute({ root: '/tmp/proj' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.exists).toBe(false);
    expect(parsed.path).toBeUndefined();
  });

  test('errors on nonexistent root', async () => {
    execMockFn = buildExec({ rootExists: false, modelExists: false });
    const result = await handler.execute({ root: '/tmp/nonexistent' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('/tmp/nonexistent');
  });

  test('uses CLAUDE_PROJECT_DIR when root omitted', async () => {
    process.env.CLAUDE_PROJECT_DIR = '/tmp/env-root';
    execMockFn = buildExec({ rootExists: true, modelExists: true });
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.path).toBe('/tmp/env-root/docs/DOMAIN-MODEL.md');
  });

  test('explicit root takes precedence over CLAUDE_PROJECT_DIR', async () => {
    process.env.CLAUDE_PROJECT_DIR = '/tmp/env-root';
    execMockFn = buildExec({ rootExists: true, modelExists: true });
    const result = await handler.execute({ root: '/tmp/explicit' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.path).toBe('/tmp/explicit/docs/DOMAIN-MODEL.md');
  });
});
