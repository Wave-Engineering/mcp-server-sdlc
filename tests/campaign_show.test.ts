import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  installChildProcessMock,
  setExecMock,
  resetExecMock,
  execCalls,
  execCallsDetailed,
} from '../lib/test-support/mock-child-process.ts';

installChildProcessMock();

const { default: handler } = await import('../handlers/campaign_show.ts');

function resetMocks() {
  resetExecMock();
  setExecMock(() => '');
}

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

const FRESH_OUTPUT = `Project:      test-project
Active Stage: none
Stages:
  concept: not_started
  prd: not_started
  backlog: not_started
  implementation: not_started
  dod: not_started
Deferrals:    0
`;

const ACTIVE_OUTPUT = `Project:      my-project
Active Stage: prd
Stages:
  concept: complete
  prd: in_review
  backlog: not_started
  implementation: not_started
  dod: not_started
Deferrals:    0
`;

const WITH_DEFERRALS = `Project:      test-project
Active Stage: none
Stages:
  concept: complete
  prd: not_started
  backlog: not_started
  implementation: not_started
  dod: not_started
Deferrals:    2
  - telemetry-rework: needs schema RFC (stage: concept)
  - feature-flag-cleanup: scope creep (stage: None)
`;

// Deferral items often contain colons (Jira-style IDs like "PROJ-123: title").
// The parser must split on the LAST ": " so the item captures everything up to
// the reason, not just the first colon-prefixed token.
const WITH_COLON_ITEMS = `Project:      test-project
Active Stage: none
Stages:
  concept: not_started
  prd: not_started
  backlog: not_started
  implementation: not_started
  dod: not_started
Deferrals:    2
  - PROJ-123: add monitoring: downstream dep not ready (stage: prd)
  - feat: refactor pipeline: needs owner approval (stage: None)
`;

describe('campaign_show handler', () => {
  beforeEach(() => resetMocks());
  afterEach(() => resetMocks());

  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('campaign_show');
    expect(typeof handler.execute).toBe('function');
  });

  test('returns state for a fresh campaign', async () => {
    setExecMock(() => FRESH_OUTPUT);
    const result = await handler.execute({ root: '/tmp/repo' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.project).toBe('test-project');
    expect(parsed.current_stage).toBeNull();
    expect(parsed.stages).toEqual({
      concept: 'not_started',
      prd: 'not_started',
      backlog: 'not_started',
      implementation: 'not_started',
      dod: 'not_started',
    });
    expect(parsed.deferrals).toEqual([]);
  });

  test('returns active_stage when set', async () => {
    setExecMock(() => ACTIVE_OUTPUT);
    const result = await handler.execute({ root: '/tmp/repo' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.project).toBe('my-project');
    expect(parsed.current_stage).toBe('prd');
    expect(parsed.stages.concept).toBe('complete');
    expect(parsed.stages.prd).toBe('in_review');
  });

  test('returns deferrals when present', async () => {
    setExecMock(() => WITH_DEFERRALS);
    const result = await handler.execute({ root: '/tmp/repo' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.deferrals).toHaveLength(2);
    expect(parsed.deferrals[0]).toEqual({
      item: 'telemetry-rework',
      reason: 'needs schema RFC',
      stage: 'concept',
    });
    expect(parsed.deferrals[1]).toEqual({
      item: 'feature-flag-cleanup',
      reason: 'scope creep',
      stage: null,
    });
  });

  test('parses deferrals whose items contain colons (splits on last ": ")', async () => {
    setExecMock(() => WITH_COLON_ITEMS);
    const result = await handler.execute({ root: '/tmp/repo' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.deferrals).toHaveLength(2);
    expect(parsed.deferrals[0]).toEqual({
      item: 'PROJ-123: add monitoring',
      reason: 'downstream dep not ready',
      stage: 'prd',
    });
    expect(parsed.deferrals[1]).toEqual({
      item: 'feat: refactor pipeline',
      reason: 'needs owner approval',
      stage: null,
    });
  });

  test('errors when CLI fails (.sdlc missing)', async () => {
    setExecMock(() => {
      throw new Error('Error: not a campaign-status project');
    });
    const result = await handler.execute({ root: '/tmp/no-sdlc' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('campaign-status show failed');
  });

  test('passes correct cwd to CLI', async () => {
    setExecMock(() => FRESH_OUTPUT);
    await handler.execute({ root: '/tmp/some-repo' });
    expect(execCalls()[0]).toBe('campaign-status show');
    expect((execCallsDetailed()[0].opts as { cwd?: string }).cwd).toBe('/tmp/some-repo');
  });

  test('uses CLAUDE_PROJECT_DIR when root not provided', async () => {
    const oldEnv = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = '/tmp/from-env';
    setExecMock(() => FRESH_OUTPUT);
    try {
      await handler.execute({});
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
