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
});
