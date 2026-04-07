import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';

let lastExecCall = '';
let execMockFn: (cmd: string) => string = () => 'flight plan stored\n';

const mockExecSync = mock((cmd: string, _opts?: unknown) => {
  lastExecCall = cmd;
  return execMockFn(cmd);
});

const mockWriteFileSync = mock((_path: unknown, _data: unknown) => undefined);

mock.module('child_process', () => ({ execSync: mockExecSync }));
mock.module('fs', () => ({ writeFileSync: mockWriteFileSync }));

const { default: handler } = await import('../handlers/wave_flight_plan.ts');

function resetMocks() {
  lastExecCall = '';
  execMockFn = () => 'flight plan stored\n';
  mockExecSync.mockClear();
  mockWriteFileSync.mockClear();
}

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe('wave_flight_plan handler', () => {
  beforeEach(resetMocks);
  afterEach(resetMocks);

  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('wave_flight_plan');
    expect(typeof handler.execute).toBe('function');
  });

  test('happy_path — writes plan to temp file and invokes wave-status flight-plan', async () => {
    const planJson = JSON.stringify([{ issues: [5, 6], status: 'pending' }]);
    const result = await handler.execute({ plan_json: planJson });
    expect(mockWriteFileSync.mock.calls.length).toBe(1);
    const writtenPath = mockWriteFileSync.mock.calls[0][0] as string;
    expect(writtenPath).toMatch(/^\/tmp\/wave-flight-plan-/);
    expect(mockWriteFileSync.mock.calls[0][1]).toBe(planJson);
    expect(lastExecCall).toContain('wave-status flight-plan');
    expect(lastExecCall).toContain(writtenPath);
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toBe('flight plan stored');
  });

  test('cli_error — returns ok:false on non-zero exit', async () => {
    execMockFn = () => {
      throw new Error('wave-status: no current wave');
    };
    const result = await handler.execute({ plan_json: '[]' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('no current wave');
  });

  test('schema_validation — rejects missing plan_json', async () => {
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });

  test('schema_validation — rejects empty plan_json string', async () => {
    const result = await handler.execute({ plan_json: '' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });
});
