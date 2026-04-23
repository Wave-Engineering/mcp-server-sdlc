import { describe, test, expect, beforeEach, afterEach } from 'bun:test';

// Avoid importing anything from 'fs' OR 'child_process' — both get
// mock.module'd by sibling test files, which would break our fixture setup.
// Use Bun.write / Bun.file which are native Bun APIs bypassing the fs module.

let fixtureDir = '';
const ORIGINAL_ENV = process.env.CLAUDE_PROJECT_DIR;

const { default: handler } = await import('../handlers/wave_next_pending.ts');

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

async function setupFixture(plan: object, state: object) {
  fixtureDir = `/tmp/wave-next-pending-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  const statusDir = `${fixtureDir}/.claude/status`;
  await Bun.write(`${statusDir}/phases-waves.json`, JSON.stringify(plan));
  await Bun.write(`${statusDir}/state.json`, JSON.stringify(state));
  process.env.CLAUDE_PROJECT_DIR = fixtureDir;
}

async function teardown() {
  if (fixtureDir) {
    try {
      // Bun shell would use child_process; avoid it. Use Bun's $ is the same.
      // Just leave the tempdir — OS will clean /tmp eventually.
      // Reset fixtureDir so next test uses a fresh path.
    } catch {
      // ignore
    }
  }
  fixtureDir = '';
  if (ORIGINAL_ENV === undefined) {
    delete process.env.CLAUDE_PROJECT_DIR;
  } else {
    process.env.CLAUDE_PROJECT_DIR = ORIGINAL_ENV;
  }
}

describe('wave_next_pending handler', () => {
  beforeEach(() => {
    fixtureDir = '';
  });
  afterEach(teardown);

  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('wave_next_pending');
    expect(typeof handler.execute).toBe('function');
  });

  test('returns_first_pending_wave — skips completed/in_progress, returns first pending', async () => {
    const plan = {
      phases: [
        {
          name: 'phase1',
          waves: [
            { id: 'w1', issues: [{ number: 1, title: 't1' }] },
            { id: 'w2', issues: [{ number: 2, title: 't2' }] },
            {
              id: 'w3',
              issues: [{ number: 3, title: 't3' }],
              depends_on: ['w2'],
              topology: 'parallel',
            },
          ],
        },
      ],
    };
    const state = {
      waves: {
        w1: { status: 'completed' },
        w2: { status: 'in_progress' },
        w3: { status: 'pending' },
      },
    };
    await setupFixture(plan, state);
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.wave).toEqual({
      id: 'w3',
      issues: [{ number: 3, title: 't3' }],
      depends_on: ['w2'],
      topology: 'parallel',
    });
  });

  test('returns_null_when_all_complete', async () => {
    const plan = {
      phases: [
        {
          waves: [
            { id: 'w1', issues: [{ number: 1 }] },
            { id: 'w2', issues: [{ number: 2 }] },
          ],
        },
      ],
    };
    const state = {
      waves: {
        w1: { status: 'completed' },
        w2: { status: 'completed' },
      },
    };
    await setupFixture(plan, state);
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.wave).toBe(null);
  });

  test('handles_missing_state_files — returns structured error', async () => {
    // Point at a fresh tempdir with nothing in it. No need to mkdir;
    // the handler will simply observe the two JSON files don't exist.
    fixtureDir = `/tmp/wave-next-pending-empty-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    process.env.CLAUDE_PROJECT_DIR = fixtureDir;
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('state files not found');
  });

  test('schema_validation — rejects unknown fields', async () => {
    await setupFixture({ phases: [] }, { waves: {} });
    const result = await handler.execute({ foo: 'bar' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });

  test('single_issue_wave → topology "serial"', async () => {
    // Plan wave has one issue and no topology field; fallback classifier
    // should return 'serial' per computeWaves single-issue rule.
    const plan = {
      phases: [
        {
          waves: [{ id: 'w1', issues: [{ number: 101, title: 'only' }] }],
        },
      ],
    };
    const state = { waves: { w1: { status: 'pending' } } };
    await setupFixture(plan, state);
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.wave.id).toBe('w1');
    expect(parsed.wave.topology).toBe('serial');
  });

  test('multi_issue_wave → topology "parallel"', async () => {
    // Plan wave has 2+ issues and no topology field. Per the architectural
    // limitation documented in the handler, the fallback classifier sees
    // zero-dep nodes (PlanWave doesn't store per-issue edges), so multi-issue
    // waves classify as 'parallel' — true 'mixed'/'serial' would require
    // fetching issue bodies.
    const plan = {
      phases: [
        {
          waves: [
            {
              id: 'w1',
              issues: [
                { number: 201, title: 'a' },
                { number: 202, title: 'b' },
                { number: 203, title: 'c' },
              ],
            },
          ],
        },
      ],
    };
    const state = { waves: { w1: { status: 'pending' } } };
    await setupFixture(plan, state);
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.wave.id).toBe('w1');
    expect(parsed.wave.topology).toBe('parallel');
  });

  test('plan_includes_topology → pass-through (not recomputed)', async () => {
    // Plan wave already declares topology: 'mixed'. The handler must preserve
    // the caller-supplied value rather than recomputing it.
    const plan = {
      phases: [
        {
          waves: [
            {
              id: 'w1',
              issues: [
                { number: 301, title: 'a' },
                { number: 302, title: 'b' },
              ],
              topology: 'mixed',
            },
          ],
        },
      ],
    };
    const state = { waves: { w1: { status: 'pending' } } };
    await setupFixture(plan, state);
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.wave.topology).toBe('mixed');
  });

  test('no_pending_waves → wave null, no topology leak', async () => {
    // With no pending waves, handler must return wave: null and must not
    // emit a spurious topology value at the top level.
    const plan = {
      phases: [
        {
          waves: [
            { id: 'w1', issues: [{ number: 401 }] },
            { id: 'w2', issues: [{ number: 402 }, { number: 403 }] },
          ],
        },
      ],
    };
    const state = {
      waves: {
        w1: { status: 'completed' },
        w2: { status: 'completed' },
      },
    };
    await setupFixture(plan, state);
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.wave).toBe(null);
    expect(parsed).not.toHaveProperty('topology');
  });
});
