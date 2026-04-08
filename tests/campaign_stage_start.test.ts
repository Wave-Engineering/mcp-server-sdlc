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

const { default: handler } = await import('../handlers/campaign_stage_start.ts');

function resetMocks() {
  execCalls = [];
  execMockFn = () => '';
  mockExecSync.mockClear();
}

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe('campaign_stage_start handler', () => {
  beforeEach(() => resetMocks());
  afterEach(() => resetMocks());

  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('campaign_stage_start');
    expect(typeof handler.execute).toBe('function');
  });

  test('starts concept stage successfully', async () => {
    execMockFn = () => "Stage 'concept' is now active.\n";
    const result = await handler.execute({ stage: 'concept', root: '/tmp/repo' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.stage).toBe('concept');
    expect(parsed.new_state).toBe('active');
    expect(parsed.cli_output).toContain('concept');
  });

  test('starts prd stage (not /devspec — internal id is prd per rename carveout)', async () => {
    execMockFn = () => "Stage 'prd' is now active.\n";
    const result = await handler.execute({ stage: 'prd', root: '/tmp/repo' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.stage).toBe('prd');
  });

  test('starts each valid stage', async () => {
    execMockFn = () => "Stage 'x' is now active.\n";
    for (const stage of ['concept', 'prd', 'backlog', 'implementation', 'dod']) {
      const result = await handler.execute({ stage, root: '/tmp/repo' });
      const parsed = parseResult(result);
      expect(parsed.ok).toBe(true);
      expect(parsed.stage).toBe(stage);
    }
  });

  test('passes stage as positional arg to CLI', async () => {
    execMockFn = () => "Stage 'concept' is now active.\n";
    await handler.execute({ stage: 'concept', root: '/tmp/myrepo' });
    const call = execCalls[0];
    expect(call.cmd).toBe(`campaign-status stage-start 'concept'`);
    expect(call.opts?.cwd).toBe('/tmp/myrepo');
  });

  test('rejects invalid stage name', async () => {
    const result = await handler.execute({ stage: 'foo', root: '/tmp/repo' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });

  test('errors when CLI fails (out-of-order transition)', async () => {
    execMockFn = () => {
      throw new Error('cannot start prd until concept is complete');
    };
    const result = await handler.execute({ stage: 'prd', root: '/tmp/repo' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('campaign-status stage-start prd failed');
  });

  test('errors when .sdlc missing (CLI throws)', async () => {
    execMockFn = () => {
      throw new Error('Error: not a campaign-status project (.sdlc/ missing)');
    };
    const result = await handler.execute({ stage: 'concept', root: '/tmp/repo' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });

  test('uses CLAUDE_PROJECT_DIR when root not provided', async () => {
    const oldEnv = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = '/tmp/from-env';
    execMockFn = () => "Stage 'concept' is now active.\n";
    try {
      await handler.execute({ stage: 'concept' });
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
