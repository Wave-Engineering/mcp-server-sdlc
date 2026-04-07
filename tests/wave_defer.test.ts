import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';

let lastExecCall = '';
let execMockFn: (cmd: string) => string = () => 'deferral recorded\n';

const mockExecSync = mock((cmd: string, _opts?: unknown) => {
  lastExecCall = cmd;
  return execMockFn(cmd);
});

mock.module('child_process', () => ({ execSync: mockExecSync }));

const { default: handler } = await import('../handlers/wave_defer.ts');

function resetMocks() {
  lastExecCall = '';
  execMockFn = () => 'deferral recorded\n';
  mockExecSync.mockClear();
}

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe('wave_defer handler', () => {
  beforeEach(resetMocks);
  afterEach(resetMocks);

  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('wave_defer');
    expect(typeof handler.execute).toBe('function');
  });

  test('happy_path — invokes wave-status defer with description + risk', async () => {
    const result = await handler.execute({
      description: 'flaky test',
      risk: 'low',
    });
    expect(lastExecCall).toContain('wave-status defer');
    expect(lastExecCall).toContain("'flaky test'");
    expect(lastExecCall).toContain(' low');
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toBe('deferral recorded');
  });

  test('happy_path — accepts medium and high risk', async () => {
    await handler.execute({ description: 'a', risk: 'medium' });
    expect(lastExecCall).toContain(' medium');
    await handler.execute({ description: 'b', risk: 'high' });
    expect(lastExecCall).toContain(' high');
  });

  test('cli_error — returns ok:false on non-zero exit', async () => {
    execMockFn = () => {
      throw new Error('wave-status: invalid risk');
    };
    const result = await handler.execute({ description: 'x', risk: 'low' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('invalid risk');
  });

  test('schema_validation — rejects missing description', async () => {
    const result = await handler.execute({ risk: 'low' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });

  test('schema_validation — rejects missing risk', async () => {
    const result = await handler.execute({ description: 'x' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });

  test('schema_validation — rejects invalid risk level', async () => {
    const result = await handler.execute({ description: 'x', risk: 'critical' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });
});
