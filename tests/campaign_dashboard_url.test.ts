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

const { default: handler } = await import('../handlers/campaign_dashboard_url.ts');

function resetMocks() {
  execCalls = [];
  execMockFn = () => '';
  mockExecSync.mockClear();
}

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe('campaign_dashboard_url handler', () => {
  beforeEach(() => resetMocks());
  afterEach(() => resetMocks());

  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('campaign_dashboard_url');
    expect(typeof handler.execute).toBe('function');
  });

  test('returns URL for current branch when branch not specified', async () => {
    execMockFn = () => 'https://dashboard.example.com/wave-engineering/myrepo/main\n';
    const result = await handler.execute({ root: '/tmp/repo' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.url).toBe('https://dashboard.example.com/wave-engineering/myrepo/main');
  });

  test('returns URL for specific branch', async () => {
    execMockFn = () =>
      'https://dashboard.example.com/wave-engineering/myrepo/feature-foo\n';
    const result = await handler.execute({
      branch: 'feature-foo',
      root: '/tmp/repo',
    });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.url).toContain('feature-foo');
  });

  test('does not pass --branch when branch arg omitted', async () => {
    execMockFn = () => 'https://example.com/x\n';
    await handler.execute({ root: '/tmp/repo' });
    const call = execCalls[0];
    expect(call.cmd).toBe('campaign-status dashboard-url');
    expect(call.cmd).not.toContain('--branch');
  });

  test('passes --branch when branch arg given', async () => {
    execMockFn = () => 'https://example.com/x\n';
    await handler.execute({ branch: 'my-branch', root: '/tmp/repo' });
    const call = execCalls[0];
    expect(call.cmd).toBe(`campaign-status dashboard-url --branch 'my-branch'`);
    expect(call.opts?.cwd).toBe('/tmp/repo');
  });

  test('errors when CLI fails (no remote configured)', async () => {
    execMockFn = () => {
      throw new Error('Error: could not detect org/repo from git remote');
    };
    const result = await handler.execute({ root: '/tmp/repo' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('campaign-status dashboard-url failed');
  });

  test('errors when CLI returns empty output', async () => {
    execMockFn = () => '';
    const result = await handler.execute({ root: '/tmp/repo' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('empty output');
  });

  test('uses CLAUDE_PROJECT_DIR when root not provided', async () => {
    const oldEnv = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = '/tmp/from-env';
    execMockFn = () => 'https://example.com/x\n';
    try {
      await handler.execute({});
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
