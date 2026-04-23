import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';

// ---- Mocks ----------------------------------------------------------------
let lastExecCall = '';
let execMockFn: (cmd: string) => string = () => 'wave plan initialized\n';

const mockExecSync = mock((cmd: string, _opts?: unknown) => {
  lastExecCall = cmd;
  return execMockFn(cmd);
});

const mockWriteFileSync = mock((_path: unknown, _data: unknown) => undefined);

mock.module('child_process', () => ({ execSync: mockExecSync }));
mock.module('fs', () => ({ writeFileSync: mockWriteFileSync }));

const { default: handler } = await import('../handlers/wave_init.ts');

const ORIGINAL_ENV = process.env.CLAUDE_PROJECT_DIR;

function resetMocks() {
  lastExecCall = '';
  execMockFn = () => 'wave plan initialized\n';
  mockExecSync.mockClear();
  mockWriteFileSync.mockClear();
}

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

async function setupStatusFixture(
  state: object | null,
  phasesWaves: object | null = null
): Promise<string> {
  const fixtureDir = `/tmp/wave-init-fixture-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  const statusDir = `${fixtureDir}/.claude/status`;
  if (state !== null) {
    await Bun.write(`${statusDir}/state.json`, JSON.stringify(state));
  }
  if (phasesWaves !== null) {
    await Bun.write(`${statusDir}/phases-waves.json`, JSON.stringify(phasesWaves));
  }
  process.env.CLAUDE_PROJECT_DIR = fixtureDir;
  return fixtureDir;
}

function clearEnv() {
  if (ORIGINAL_ENV === undefined) {
    delete process.env.CLAUDE_PROJECT_DIR;
  } else {
    process.env.CLAUDE_PROJECT_DIR = ORIGINAL_ENV;
  }
}

describe('wave_init handler', () => {
  beforeEach(resetMocks);
  afterEach(() => {
    resetMocks();
    clearEnv();
  });

  test('handler exports valid HandlerDef shape', () => {
    expect(handler).toBeDefined();
    expect(handler.name).toBe('wave_init');
    expect(typeof handler.description).toBe('string');
    expect(handler.description.length).toBeGreaterThan(0);
    expect(handler.inputSchema).toBeDefined();
    expect(typeof handler.execute).toBe('function');
  });

  // ---- happy_path ---------------------------------------------------------
  test('happy_path — invokes wave-status init with plan file', async () => {
    // Fresh init (no --extend) does NOT read state.json, so no fixture required.
    // Point CLAUDE_PROJECT_DIR at a tempdir so the post-CLI phases-waves read
    // simply reports 0 totals.
    await setupStatusFixture(null);
    const planJson = JSON.stringify({ project: 'foo', phases: [] });
    const result = await handler.execute({ plan_json: planJson });
    expect(mockExecSync.mock.calls.length).toBe(1);
    expect(lastExecCall).toContain('wave-status init');
    expect(lastExecCall).not.toContain('--extend');
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.mode).toBe('init');
  });

  test('happy_path — passes --extend flag when extend=true', async () => {
    await setupStatusFixture({ waves: {} }, { phases: [] });
    const planJson = JSON.stringify({ phases: [{ name: 'extra', waves: [] }] });
    await handler.execute({ plan_json: planJson, extend: true });
    expect(lastExecCall).toContain('wave-status init');
    expect(lastExecCall).toContain('--extend');
  });

  test('happy_path — writes plan_json to a temp file', async () => {
    await setupStatusFixture(null);
    const planJson = JSON.stringify({ project: 'cc-workflow' });
    await handler.execute({ plan_json: planJson });
    expect(mockWriteFileSync.mock.calls.length).toBe(1);
    const writtenPath = mockWriteFileSync.mock.calls[0][0] as string;
    const writtenData = mockWriteFileSync.mock.calls[0][1] as string;
    expect(writtenPath).toMatch(/^\/tmp\/wave-init-plan-/);
    expect(writtenData).toBe(planJson);
  });

  // ---- cli_error ----------------------------------------------------------
  test('cli_error — returns ok:false on non-zero exit, does not throw', async () => {
    await setupStatusFixture(null);
    execMockFn = () => {
      throw new Error('wave-status: refusing to overwrite existing plan');
    };
    const result = await handler.execute({ plan_json: '{}' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('refusing to overwrite');
  });

  // ---- schema_validation --------------------------------------------------
  test('schema_validation — rejects missing plan_json', async () => {
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.length).toBeGreaterThan(0);
  });

  test('schema_validation — rejects empty plan_json string', async () => {
    const result = await handler.execute({ plan_json: '' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('plan_json');
  });

  test('schema_validation — rejects non-string plan_json', async () => {
    const result = await handler.execute({ plan_json: 123 });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });

  // ---- extend_collision ---------------------------------------------------
  test('extend_collision — returns ok:false with colliding_ids, does NOT invoke CLI', async () => {
    await setupStatusFixture(
      { waves: { 'W-1': { status: 'completed' } } },
      { phases: [{ waves: [{ id: 'W-1' }] }] }
    );
    const planJson = JSON.stringify({
      phases: [{ name: 'p1', waves: [{ id: 'W-1', issues: [{ number: 10 }] }] }],
    });
    const result = await handler.execute({ plan_json: planJson, extend: true });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(Array.isArray(parsed.colliding_ids)).toBe(true);
    expect(parsed.colliding_ids).toContain('W-1');
    expect(mockExecSync.mock.calls.length).toBe(0);
  });

  // ---- extend_no_collision ------------------------------------------------
  test('extend_no_collision — rich payload on success', async () => {
    await setupStatusFixture(
      { waves: { 'W-1': { status: 'completed' } } },
      {
        phases: [
          { waves: [{ id: 'W-1' }] },
          { waves: [{ id: 'W-2' }] },
        ],
      }
    );
    const planJson = JSON.stringify({
      phases: [
        {
          name: 'p2',
          waves: [
            {
              id: 'W-2',
              issues: [
                { number: 20 },
                { number: 21 },
              ],
            },
          ],
        },
      ],
    });
    const result = await handler.execute({ plan_json: planJson, extend: true });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.mode).toBe('extend');
    expect(parsed.waves_added).toBeGreaterThanOrEqual(1);
    expect(parsed.phases_added).toBeGreaterThanOrEqual(1);
    expect(parsed.issues_added).toBe(2);
    expect(typeof parsed.total_phases).toBe('number');
    expect(typeof parsed.total_waves).toBe('number');
    expect(mockExecSync.mock.calls.length).toBe(1);
  });

  // ---- fresh_init_rich_payload --------------------------------------------
  test('fresh_init_rich_payload — non-extend path returns numeric totals', async () => {
    await setupStatusFixture(null, {
      phases: [
        { waves: [{ id: 'W-1' }, { id: 'W-2' }] },
      ],
    });
    const planJson = JSON.stringify({
      phases: [
        {
          name: 'p1',
          waves: [
            { id: 'W-1', issues: [{ number: 1 }] },
            { id: 'W-2', issues: [{ number: 2 }, { number: 3 }] },
          ],
        },
      ],
    });
    const result = await handler.execute({ plan_json: planJson, extend: false });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.mode).toBe('init');
    expect(typeof parsed.phases_added).toBe('number');
    expect(parsed.phases_added).toBe(1);
    expect(parsed.waves_added).toBe(2);
    expect(parsed.issues_added).toBe(3);
    expect(typeof parsed.total_waves).toBe('number');
  });

  // ---- extend_missing_state -----------------------------------------------
  test('extend_missing_state — returns ok:false without throwing', async () => {
    // Point at a fresh empty tempdir; no state.json exists.
    const fixtureDir = `/tmp/wave-init-empty-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    process.env.CLAUDE_PROJECT_DIR = fixtureDir;
    const planJson = JSON.stringify({
      phases: [{ name: 'p1', waves: [{ id: 'W-9', issues: [] }] }],
    });
    const result = await handler.execute({ plan_json: planJson, extend: true });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(typeof parsed.error).toBe('string');
    expect(mockExecSync.mock.calls.length).toBe(0);
  });
});
