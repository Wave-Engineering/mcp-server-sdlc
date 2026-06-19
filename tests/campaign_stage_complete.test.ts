import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  installChildProcessMock,
  setExecMock,
  resetExecMock,
  execCallsDetailed,
} from '../lib/test-support/mock-child-process.ts';

installChildProcessMock();

const { default: handler } = await import('../handlers/campaign_stage_complete.ts');

function resetMocks() {
  resetExecMock();
  setExecMock(() => '');
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
    setExecMock(() => "Stage 'concept' is now complete.\n");
    const result = await handler.execute({ stage: 'concept', root: '/tmp/repo' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.stage).toBe('concept');
    expect(parsed.campaign_complete).toBe(false);
  });

  test('completes dod stage with campaign_complete:true', async () => {
    setExecMock(() => "Stage 'dod' is now complete.\n");
    const result = await handler.execute({ stage: 'dod', root: '/tmp/repo' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.campaign_complete).toBe(true);
  });

  test('completes each non-dod stage with campaign_complete:false', async () => {
    setExecMock(() => "Stage 'x' is now complete.\n");
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
    setExecMock(() => "Stage 'prd' is now complete.\n");
    await handler.execute({ stage: 'prd', root: '/tmp/myrepo' });
    const call = execCallsDetailed()[0];
    expect(call.cmd).toBe(`campaign-status stage-complete 'prd'`);
    expect((call.opts as { cwd?: string }).cwd).toBe('/tmp/myrepo');
  });

  test('errors when CLI fails (review-gated stage not reviewed)', async () => {
    setExecMock(() => {
      throw new Error('Error: stage prd must be reviewed before completion');
    });
    const result = await handler.execute({ stage: 'prd', root: '/tmp/repo' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('campaign-status stage-complete prd failed');
  });

  test('uses CLAUDE_PROJECT_DIR when root not provided', async () => {
    const oldEnv = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = '/tmp/from-env';
    setExecMock(() => "Stage 'concept' is now complete.\n");
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
