import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';

let lastExecCall = '';
let execMockFn: (cmd: string) => string = () => 'preflight ok\n';

const mockExecSync = mock((cmd: string, _opts?: unknown) => {
  lastExecCall = cmd;
  return execMockFn(cmd);
});

mock.module('child_process', () => ({ execSync: mockExecSync }));

const { default: handler } = await import('../handlers/wave_preflight.ts');

function resetMocks() {
  lastExecCall = '';
  execMockFn = () => 'preflight ok\n';
  mockExecSync.mockClear();
}

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe('wave_preflight handler', () => {
  beforeEach(resetMocks);
  afterEach(resetMocks);

  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('wave_preflight');
    expect(typeof handler.description).toBe('string');
    expect(handler.description.length).toBeGreaterThan(0);
    expect(typeof handler.execute).toBe('function');
  });

  test('happy_path — invokes wave-status preflight', async () => {
    const result = await handler.execute({});
    expect(mockExecSync.mock.calls.length).toBe(1);
    expect(lastExecCall).toBe('wave-status preflight');
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toBe('preflight ok');
  });

  test('cli_error — returns ok:false on non-zero exit, does not throw', async () => {
    execMockFn = () => {
      throw new Error('wave-status: state file missing');
    };
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('state file missing');
  });

  test('schema_validation — rejects unknown input fields', async () => {
    const result = await handler.execute({ unexpected: 'field' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });
});
