import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  installChildProcessMock,
  setExecMock,
  resetExecMock,
  execCallsDetailed,
} from '../lib/test-support/mock-child-process.ts';

installChildProcessMock();

const { default: handler } = await import('../handlers/campaign_stage_review.ts');

function resetMocks() {
  resetExecMock();
  setExecMock(() => '');
}

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe('campaign_stage_review handler', () => {
  beforeEach(() => resetMocks());
  afterEach(() => resetMocks());

  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('campaign_stage_review');
    expect(typeof handler.execute).toBe('function');
  });

  test('marks concept for review', async () => {
    setExecMock(() => "Stage 'concept' is now in review.\n");
    const result = await handler.execute({ stage: 'concept', root: '/tmp/repo' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.stage).toBe('concept');
  });

  test('marks prd for review', async () => {
    setExecMock(() => "Stage 'prd' is now in review.\n");
    const result = await handler.execute({ stage: 'prd', root: '/tmp/repo' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.stage).toBe('prd');
  });

  test('marks dod for review', async () => {
    setExecMock(() => "Stage 'dod' is now in review.\n");
    const result = await handler.execute({ stage: 'dod', root: '/tmp/repo' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.stage).toBe('dod');
  });

  test('rejects backlog (not review-gated)', async () => {
    const result = await handler.execute({ stage: 'backlog', root: '/tmp/repo' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });

  test('rejects implementation (not review-gated)', async () => {
    const result = await handler.execute({ stage: 'implementation', root: '/tmp/repo' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });

  test('rejects unknown stage', async () => {
    const result = await handler.execute({ stage: 'foo', root: '/tmp/repo' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });

  test('passes stage to CLI with correct cwd', async () => {
    setExecMock(() => "Stage 'concept' is now in review.\n");
    await handler.execute({ stage: 'concept', root: '/tmp/myrepo' });
    const call = execCallsDetailed()[0];
    expect(call.cmd).toBe(`campaign-status stage-review 'concept'`);
    expect((call.opts as { cwd?: string }).cwd).toBe('/tmp/myrepo');
  });

  test('errors when CLI fails (stage not active)', async () => {
    setExecMock(() => {
      throw new Error('Error: stage prd is not currently active');
    });
    const result = await handler.execute({ stage: 'prd', root: '/tmp/repo' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('campaign-status stage-review prd failed');
  });

  test('uses CLAUDE_PROJECT_DIR when root not provided', async () => {
    const oldEnv = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = '/tmp/from-env';
    setExecMock(() => "Stage 'concept' is now in review.\n");
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
