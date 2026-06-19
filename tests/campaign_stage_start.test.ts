import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  installChildProcessMock,
  setExecMock,
  resetExecMock,
  execCallsDetailed,
} from '../lib/test-support/mock-child-process.ts';

installChildProcessMock();

const { default: handler } = await import('../handlers/campaign_stage_start.ts');

function resetMocks() {
  resetExecMock();
  setExecMock(() => '');
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
    setExecMock(() => "Stage 'concept' is now active.\n");
    const result = await handler.execute({ stage: 'concept', root: '/tmp/repo' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.stage).toBe('concept');
    expect(parsed.new_state).toBe('active');
    expect(parsed.cli_output).toContain('concept');
  });

  test('starts prd stage (not /devspec — internal id is prd per rename carveout)', async () => {
    setExecMock(() => "Stage 'prd' is now active.\n");
    const result = await handler.execute({ stage: 'prd', root: '/tmp/repo' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.stage).toBe('prd');
  });

  test('starts each valid stage', async () => {
    setExecMock(() => "Stage 'x' is now active.\n");
    for (const stage of ['concept', 'prd', 'backlog', 'implementation', 'dod']) {
      const result = await handler.execute({ stage, root: '/tmp/repo' });
      const parsed = parseResult(result);
      expect(parsed.ok).toBe(true);
      expect(parsed.stage).toBe(stage);
    }
  });

  test('passes stage as positional arg to CLI', async () => {
    setExecMock(() => "Stage 'concept' is now active.\n");
    await handler.execute({ stage: 'concept', root: '/tmp/myrepo' });
    const call = execCallsDetailed()[0];
    expect(call.cmd).toBe(`campaign-status stage-start 'concept'`);
    expect((call.opts as { cwd?: string }).cwd).toBe('/tmp/myrepo');
  });

  test('rejects invalid stage name', async () => {
    const result = await handler.execute({ stage: 'foo', root: '/tmp/repo' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });

  test('errors when CLI fails (out-of-order transition)', async () => {
    setExecMock(() => {
      throw new Error('cannot start prd until concept is complete');
    });
    const result = await handler.execute({ stage: 'prd', root: '/tmp/repo' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('campaign-status stage-start prd failed');
  });

  test('errors when .sdlc missing (CLI throws)', async () => {
    setExecMock(() => {
      throw new Error('Error: not a campaign-status project (.sdlc/ missing)');
    });
    const result = await handler.execute({ stage: 'concept', root: '/tmp/repo' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });

  test('uses CLAUDE_PROJECT_DIR when root not provided', async () => {
    const oldEnv = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = '/tmp/from-env';
    setExecMock(() => "Stage 'concept' is now active.\n");
    try {
      await handler.execute({ stage: 'concept' });
      expect((execCallsDetailed()[0].opts as { cwd?: string }).cwd).toBe('/tmp/from-env');
    } finally {
      if (oldEnv === undefined) {
        delete process.env.CLAUDE_PROJECT_DIR;
      } else {
        process.env.CLAUDE_PROJECT_DIR = oldEnv;
      }
    }
  });
});
