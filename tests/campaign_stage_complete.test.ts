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

const { default: handler } = await import('../handlers/campaign_stage_complete.ts');

function resetMocks() {
  execCalls = [];
  execMockFn = () => '';
  mockExecSync.mockClear();
}

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe('campaign_stage_complete handler', () => {
  beforeEach(() => resetMocks());
  afterEach(() => resetMocks());

  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('campaign_stage_complete');
    expect(typeof handler.execute).toBe('function');
  });

  test('completes concept stage with campaign_complete:false', async () => {
    execMockFn = () => "Stage 'concept' is now complete.\n";
    const result = await handler.execute({ stage: 'concept', root: '/tmp/repo' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.stage).toBe('concept');
    expect(parsed.campaign_complete).toBe(false);
  });

  test('completes dod stage with campaign_complete:true', async () => {
    execMockFn = () => "Stage 'dod' is now complete.\n";
    const result = await handler.execute({ stage: 'dod', root: '/tmp/repo' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.campaign_complete).toBe(true);
  });

  test('completes each non-dod stage with campaign_complete:false', async () => {
    execMockFn = () => "Stage 'x' is now complete.\n";
    for (const stage of ['concept', 'prd', 'backlog', 'implementation']) {
      const result = await handler.execute({ stage, root: '/tmp/repo' });
      const parsed = parseResult(result);
      expect(parsed.ok).toBe(true);
      expect(parsed.campaign_complete).toBe(false);
    }
  });

  test('rejects unknown stage', async () => {
    const result = await handler.execute({ stage: 'foo', root: '/tmp/repo' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });

  test('passes stage to CLI with correct cwd', async () => {
    execMockFn = () => "Stage 'prd' is now complete.\n";
    await handler.execute({ stage: 'prd', root: '/tmp/myrepo' });
    const call = execCalls[0];
    expect(call.cmd).toBe(`campaign-status stage-complete 'prd'`);
    expect(call.opts?.cwd).toBe('/tmp/myrepo');
  });

  test('errors when CLI fails (review-gated stage not reviewed)', async () => {
    execMockFn = () => {
      throw new Error('Error: stage prd must be reviewed before completion');
    };
    const result = await handler.execute({ stage: 'prd', root: '/tmp/repo' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('campaign-status stage-complete prd failed');
  });

  test('uses CLAUDE_PROJECT_DIR when root not provided', async () => {
    const oldEnv = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = '/tmp/from-env';
    execMockFn = () => "Stage 'concept' is now complete.\n";
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
