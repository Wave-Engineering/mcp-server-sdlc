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

const { default: handler } = await import('../handlers/campaign_defer.ts');

function resetMocks() {
  execCalls = [];
  execMockFn = () => '';
  mockExecSync.mockClear();
}

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe('campaign_defer handler', () => {
  beforeEach(() => resetMocks());
  afterEach(() => resetMocks());

  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('campaign_defer');
    expect(typeof handler.execute).toBe('function');
  });

  test('defers an item with reason', async () => {
    execMockFn = () => 'Deferred: telemetry-rework\n';
    const result = await handler.execute({
      item: 'telemetry-rework',
      reason: 'requires schema RFC',
      root: '/tmp/repo',
    });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.item).toBe('telemetry-rework');
    expect(parsed.reason).toBe('requires schema RFC');
  });

  test('passes item and --reason to CLI', async () => {
    execMockFn = () => 'Deferred: x\n';
    await handler.execute({
      item: 'my-item',
      reason: 'because reasons',
      root: '/tmp/myrepo',
    });
    const call = execCalls[0];
    expect(call.cmd).toContain(`campaign-status defer 'my-item'`);
    expect(call.cmd).toContain(`--reason 'because reasons'`);
    expect(call.opts?.cwd).toBe('/tmp/myrepo');
  });

  test('rejects empty reason', async () => {
    const result = await handler.execute({
      item: 'foo',
      reason: '',
      root: '/tmp/repo',
    });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });

  test('rejects empty item', async () => {
    const result = await handler.execute({
      item: '',
      reason: 'because',
      root: '/tmp/repo',
    });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });

  test('rejects missing item', async () => {
    const result = await handler.execute({ reason: 'because', root: '/tmp/repo' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });

  test('rejects missing reason', async () => {
    const result = await handler.execute({ item: 'foo', root: '/tmp/repo' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });

  test('errors when CLI fails (.sdlc missing)', async () => {
    execMockFn = () => {
      throw new Error('Error: not a campaign-status project');
    };
    const result = await handler.execute({
      item: 'x',
      reason: 'y',
      root: '/tmp/no-sdlc',
    });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('campaign-status defer failed');
  });

  test('handles items and reasons containing single quotes safely', async () => {
    execMockFn = () => 'Deferred: x\n';
    await handler.execute({
      item: "user's request",
      reason: "it's complicated",
      root: '/tmp/repo',
    });
    // Single-quote escape shape: 'user'\''s request'
    const call = execCalls[0];
    expect(call.cmd).toContain(`'user'\\''s request'`);
    expect(call.cmd).toContain(`'it'\\''s complicated'`);
  });

  test('uses CLAUDE_PROJECT_DIR when root not provided', async () => {
    const oldEnv = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = '/tmp/from-env';
    execMockFn = () => 'Deferred: x\n';
    try {
      await handler.execute({ item: 'foo', reason: 'bar' });
      expect(execCalls[0].opts?.cwd).toBe('/tmp/from-env');
    } finally {
      if (oldEnv === undefined) {
        delete process.env.CLAUDE_PROJECT_DIR;
      } else {
        process.env.CLAUDE_PROJECT_DIR = oldEnv;
      }
    }
  });
});
