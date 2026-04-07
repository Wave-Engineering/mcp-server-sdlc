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

function resetMocks() {
  lastExecCall = '';
  execMockFn = () => 'wave plan initialized\n';
  mockExecSync.mockClear();
  mockWriteFileSync.mockClear();
}

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe('wave_init handler', () => {
  beforeEach(resetMocks);
  afterEach(resetMocks);

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
    const planJson = JSON.stringify({ project: 'foo', phases: [] });
    const result = await handler.execute({ plan_json: planJson });
    expect(mockExecSync.mock.calls.length).toBe(1);
    expect(lastExecCall).toContain('wave-status init');
    expect(lastExecCall).not.toContain('--extend');
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toBe('wave plan initialized');
  });

  test('happy_path — passes --extend flag when extend=true', async () => {
    const planJson = JSON.stringify({ phases: [{ name: 'extra' }] });
    await handler.execute({ plan_json: planJson, extend: true });
    expect(lastExecCall).toContain('wave-status init');
    expect(lastExecCall).toContain('--extend');
  });

  test('happy_path — writes plan_json to a temp file', async () => {
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
});
