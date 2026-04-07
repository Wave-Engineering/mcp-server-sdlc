import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';

let lastExecCall = '';
let execMockFn: (cmd: string) => string = () => 'flight started\n';

const mockExecSync = mock((cmd: string, _opts?: unknown) => {
  lastExecCall = cmd;
  return execMockFn(cmd);
});

mock.module('child_process', () => ({ execSync: mockExecSync }));

const { default: handler } = await import('../handlers/wave_flight.ts');

function resetMocks() {
  lastExecCall = '';
  execMockFn = () => 'flight started\n';
  mockExecSync.mockClear();
}

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe('wave_flight handler', () => {
  beforeEach(resetMocks);
  afterEach(resetMocks);

  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('wave_flight');
    expect(typeof handler.execute).toBe('function');
  });

  test('happy_path — invokes wave-status flight with N', async () => {
    const result = await handler.execute({ flight_number: 2 });
    expect(mockExecSync.mock.calls.length).toBe(1);
    expect(lastExecCall).toBe('wave-status flight 2');
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toBe('flight started');
  });

  test('cli_error — returns ok:false on non-zero exit, does not throw', async () => {
    execMockFn = () => {
      throw new Error("wave-status: flight 2 is 'pending', not 'completed'");
    };
    const result = await handler.execute({ flight_number: 3 });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("'pending'");
  });

  test('schema_validation — rejects missing flight_number', async () => {
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });

  test('schema_validation — rejects non-integer flight_number', async () => {
    const result = await handler.execute({ flight_number: 1.5 });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });

  test('schema_validation — rejects zero or negative flight_number', async () => {
    const result = await handler.execute({ flight_number: 0 });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });
});
