import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';

// Mock only execSync (so this test can intercept gh calls without
// disturbing fs). Other tests that mock child_process use the same
// pattern, so the mock contracts are compatible.

let execMockFn: (cmd: string) => string = () => '';

const mockExecSync = mock((cmd: string, _opts?: unknown) => {
  return execMockFn(cmd);
});

mock.module('child_process', () => ({ execSync: mockExecSync }));

const { default: handler } = await import('../handlers/wave_previous_merged.ts');

let fixtureDir = '';
const ORIGINAL_ENV = process.env.CLAUDE_PROJECT_DIR;

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

async function setupFixture(plan: object, state: object) {
  fixtureDir = `/tmp/wave-prev-merged-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  const statusDir = `${fixtureDir}/.claude/status`;
  await Bun.write(`${statusDir}/phases-waves.json`, JSON.stringify(plan));
  await Bun.write(`${statusDir}/state.json`, JSON.stringify(state));
  process.env.CLAUDE_PROJECT_DIR = fixtureDir;
}

function resetMocks() {
  execMockFn = () => '';
  mockExecSync.mockClear();
  fixtureDir = '';
}

function restoreEnv() {
  if (ORIGINAL_ENV === undefined) {
    delete process.env.CLAUDE_PROJECT_DIR;
  } else {
    process.env.CLAUDE_PROJECT_DIR = ORIGINAL_ENV;
  }
}

describe('wave_previous_merged handler', () => {
  beforeEach(resetMocks);
  afterEach(restoreEnv);

  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('wave_previous_merged');
    expect(typeof handler.execute).toBe('function');
  });

  test('all_merged_returns_true — mock gh returning CLOSED for all', async () => {
    const plan = {
      phases: [
        {
          waves: [
            { id: 'w1', issues: [{ number: 1 }, { number: 2 }] },
            { id: 'w2', issues: [{ number: 3 }] },
          ],
        },
      ],
    };
    const state = {
      current_wave: 'w2',
      waves: {
        w1: { status: 'completed' },
        w2: { status: 'in_progress' },
      },
    };
    await setupFixture(plan, state);
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote')) return 'https://github.com/org/repo.git\n';
      return JSON.stringify({ state: 'closed' });
    };
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.previous_wave_id).toBe('w1');
    expect(parsed.all_merged).toBe(true);
    expect(parsed.open_issues).toEqual([]);
  });

  test('some_open_returns_list — mix of closed/open issues', async () => {
    const plan = {
      phases: [
        {
          waves: [
            { id: 'w1', issues: [{ number: 1 }, { number: 2 }, { number: 3 }] },
            { id: 'w2', issues: [{ number: 4 }] },
          ],
        },
      ],
    };
    const state = {
      current_wave: 'w2',
      waves: {
        w1: { status: 'completed' },
        w2: { status: 'in_progress' },
      },
    };
    await setupFixture(plan, state);
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote')) return 'https://github.com/org/repo.git\n';
      if (cmd.includes('gh issue view 1')) return JSON.stringify({ state: 'closed' });
      if (cmd.includes('gh issue view 2')) return JSON.stringify({ state: 'open' });
      if (cmd.includes('gh issue view 3')) return JSON.stringify({ state: 'open' });
      return JSON.stringify({ state: 'closed' });
    };
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.all_merged).toBe(false);
    expect(parsed.open_issues).toEqual([2, 3]);
  });

  test('no_previous_wave — first wave case returns ok:true with null id', async () => {
    const plan = {
      phases: [
        {
          waves: [{ id: 'w1', issues: [{ number: 1 }] }],
        },
      ],
    };
    const state = {
      current_wave: 'w1',
      waves: { w1: { status: 'in_progress' } },
    };
    await setupFixture(plan, state);
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.previous_wave_id).toBe(null);
    expect(parsed.all_merged).toBe(true);
    expect(parsed.open_issues).toEqual([]);
  });

  test('handles_missing_state_files — returns structured error', async () => {
    fixtureDir = `/tmp/wave-prev-merged-empty-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
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
