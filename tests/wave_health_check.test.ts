import { describe, test, expect, beforeEach, afterEach } from 'bun:test';

// Uses Bun.file / Bun.write — no module mocks.

const { default: handler } = await import('../handlers/wave_health_check.ts');

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

let fixtureDir = '';
const ORIGINAL_ENV = process.env.CLAUDE_PROJECT_DIR;

function restoreEnv() {
  if (ORIGINAL_ENV === undefined) {
    delete process.env.CLAUDE_PROJECT_DIR;
  } else {
    process.env.CLAUDE_PROJECT_DIR = ORIGINAL_ENV;
  }
}

async function setupState(state: object) {
  fixtureDir = `/tmp/wave-health-check-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  await Bun.write(`${fixtureDir}/.claude/status/state.json`, JSON.stringify(state));
  process.env.CLAUDE_PROJECT_DIR = fixtureDir;
}

describe('wave_health_check handler', () => {
  beforeEach(() => {
    fixtureDir = '';
  });
  afterEach(() => {
    fixtureDir = '';
    restoreEnv();
  });

  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('wave_health_check');
    expect(typeof handler.execute).toBe('function');
  });

  test('clean_state_returns_safe — no blockers, safe_to_proceed=true', async () => {
    await setupState({
      current_wave: 'w1',
      waves: { w1: { status: 'in_progress' } },
      deferrals: [],
    });
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.safe_to_proceed).toBe(true);
    expect(parsed.blockers).toEqual([]);
    expect(parsed.summary).toContain('clean');
  });

  test('deferral_blocks — pending deferral sets safe_to_proceed=false', async () => {
    await setupState({
      current_wave: 'w1',
      deferrals: [
        { status: 'pending', description: 'flaky test', risk: 'medium' },
      ],
    });
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.safe_to_proceed).toBe(false);
    expect(parsed.blockers.length).toBe(1);
    expect(parsed.blockers[0].type).toBe('deferral');
    expect(parsed.blockers[0].details.description).toBe('flaky test');
  });

  test('accepted_deferrals_are_warnings_not_blockers', async () => {
    await setupState({
      current_wave: 'w1',
      deferrals: [
        { status: 'accepted', description: 'tech debt', risk: 'low' },
      ],
    });
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.safe_to_proceed).toBe(true);
    expect(parsed.blockers).toEqual([]);
    expect(parsed.warnings.length).toBe(1);
    expect(parsed.warnings[0].type).toBe('deferral_accepted');
  });

  test('multiple_blockers_all_reported', async () => {
    await setupState({
      current_wave: 'w1',
      deferrals: [
        { status: 'pending', description: 'a', risk: 'high' },
        { status: 'pending', description: 'b', risk: 'low' },
      ],
    });
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.safe_to_proceed).toBe(false);
    expect(parsed.blockers.length).toBe(2);
  });

  test('wave_id_override — reports wave_id in response', async () => {
    await setupState({ current_wave: 'w1', deferrals: [] });
    const result = await handler.execute({ wave_id: 'w9' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.wave_id).toBe('w9');
  });

  test('handles_missing_state_file', async () => {
    fixtureDir = `/tmp/wave-health-check-empty-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    process.env.CLAUDE_PROJECT_DIR = fixtureDir;
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('state file not found');
  });

  test('schema_validation — rejects unknown fields', async () => {
    await setupState({ current_wave: 'w1', deferrals: [] });
    const result = await handler.execute({ foo: 'bar' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });
});
