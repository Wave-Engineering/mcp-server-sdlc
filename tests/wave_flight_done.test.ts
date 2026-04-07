import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';

let lastExecCall = '';
let execMockFn: (cmd: string) => string = () => 'flight done\n';

const mockExecSync = mock((cmd: string, _opts?: unknown) => {
  lastExecCall = cmd;
  return execMockFn(cmd);
});

mock.module('child_process', () => ({ execSync: mockExecSync }));

const { default: handler } = await import('../handlers/wave_flight_done.ts');

function resetMocks() {
  lastExecCall = '';
  execMockFn = () => 'flight done\n';
  mockExecSync.mockClear();
}

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe('wave_flight_done handler', () => {
  beforeEach(resetMocks);
  afterEach(resetMocks);

  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('wave_flight_done');
    expect(typeof handler.execute).toBe('function');
  });

  test('happy_path — invokes wave-status flight-done with N', async () => {
    const result = await handler.execute({ flight_number: 1 });
    expect(lastExecCall).toBe('wave-status flight-done 1');
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toBe('flight done');
  });

  test('cli_error — returns ok:false on non-zero exit', async () => {
    execMockFn = () => {
      throw new Error("wave-status: flight 1 is 'pending', not 'running'");
    };
    const result = await handler.execute({ flight_number: 1 });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain("'running'");
  });

  test('schema_validation — rejects missing flight_number', async () => {
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });

  test('schema_validation — rejects negative flight_number', async () => {
    const result = await handler.execute({ flight_number: -1 });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });
});
