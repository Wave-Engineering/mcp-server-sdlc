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

const { default: handler } = await import('../handlers/campaign_init.ts');

function resetMocks() {
  execCalls = [];
  execMockFn = () => '';
  mockExecSync.mockClear();
}

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

/**
 * Build an execSync mock that responds based on command shape:
 *   - `test -d <root>`     → opts.rootExists controls success/throw
 *   - `campaign-status init <name>` → opts.initThrows controls success/throw
 *   - `test -d <sdlc-dir>` → opts.sdlcCreated controls success/throw
 */
function buildExec(opts: {
  rootExists?: boolean;
  initThrows?: boolean;
  sdlcCreated?: boolean;
}) {
  const { rootExists = true, initThrows = false, sdlcCreated = true } = opts;
  let testCallCount = 0;
  return (cmd: string) => {
    if (cmd.startsWith('test -d')) {
      testCallCount++;
      // First test -d is the root, second is the .sdlc dir.
      if (testCallCount === 1) {
        if (!rootExists) throw new Error('root missing');
        return '';
      }
      if (!sdlcCreated) throw new Error('.sdlc missing');
      return '';
    }
    if (cmd.startsWith('campaign-status init')) {
      if (initThrows) throw new Error('Campaign already initialized');
      return "Campaign 'test-project' initialized in .sdlc/\n";
    }
    return '';
  };
}

describe('campaign_init handler', () => {
  beforeEach(() => resetMocks());
  afterEach(() => resetMocks());

  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('campaign_init');
    expect(typeof handler.execute).toBe('function');
  });

  test('initializes campaign in a fresh project', async () => {
    execMockFn = buildExec({});
    const result = await handler.execute({
      project_name: 'test-project',
      root: '/tmp/myrepo',
    });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.project_name).toBe('test-project');
    expect(parsed.sdlc_dir).toBe('/tmp/myrepo/.sdlc');
  });

  test('passes project_name to campaign-status CLI', async () => {
    execMockFn = buildExec({});
    await handler.execute({ project_name: 'my-cool-project', root: '/tmp/repo' });
    const initCall = execCalls.find(c => c.cmd.startsWith('campaign-status init'));
    expect(initCall).toBeDefined();
    expect(initCall?.cmd).toContain("'my-cool-project'");
    expect(initCall?.opts?.cwd).toBe('/tmp/repo');
  });

  test('errors when already initialized', async () => {
    execMockFn = buildExec({ initThrows: true });
    const result = await handler.execute({
      project_name: 'test-project',
      root: '/tmp/myrepo',
    });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('campaign-status init failed');
  });

  test('errors when root directory missing', async () => {
    execMockFn = buildExec({ rootExists: false });
    const result = await handler.execute({
      project_name: 'test-project',
      root: '/tmp/no-such-dir',
    });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('root not found');
  });

  test('errors when .sdlc/ not created after init succeeds', async () => {
    execMockFn = buildExec({ sdlcCreated: false });
    const result = await handler.execute({
      project_name: 'test-project',
      root: '/tmp/myrepo',
    });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('.sdlc/');
  });

  test('uses CLAUDE_PROJECT_DIR when root not provided', async () => {
    const oldEnv = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = '/tmp/from-env';
    execMockFn = buildExec({});
    try {
      const result = await handler.execute({ project_name: 'test-project' });
      const parsed = parseResult(result);
      expect(parsed.ok).toBe(true);
      expect(parsed.sdlc_dir).toBe('/tmp/from-env/.sdlc');
      const initCall = execCalls.find(c => c.cmd.startsWith('campaign-status init'));
      expect(initCall?.opts?.cwd).toBe('/tmp/from-env');
    } finally {
      if (oldEnv === undefined) {
        delete process.env.CLAUDE_PROJECT_DIR;
      } else {
        process.env.CLAUDE_PROJECT_DIR = oldEnv;
      }
    }
  });

  test('schema rejects missing project_name', async () => {
    const result = await handler.execute({ root: '/tmp/repo' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });

  test('schema rejects empty project_name', async () => {
    const result = await handler.execute({ project_name: '', root: '/tmp/repo' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });
});
