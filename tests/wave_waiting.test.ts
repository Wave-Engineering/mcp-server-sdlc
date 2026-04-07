import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';

let lastExecCall = '';
let execMockFn: (cmd: string) => string = () => 'waiting\n';

const mockExecSync = mock((cmd: string, _opts?: unknown) => {
  lastExecCall = cmd;
  return execMockFn(cmd);
});

mock.module('child_process', () => ({ execSync: mockExecSync }));

const { default: handler } = await import('../handlers/wave_waiting.ts');

function resetMocks() {
  lastExecCall = '';
  execMockFn = () => 'waiting\n';
  mockExecSync.mockClear();
}

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe('wave_waiting handler', () => {
  beforeEach(resetMocks);
  afterEach(resetMocks);

  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('wave_waiting');
    expect(typeof handler.execute).toBe('function');
  });

  test('happy_path — invokes wave-status waiting with shell-quoted reason', async () => {
    const result = await handler.execute({ reason: 'need human review' });
    expect(lastExecCall).toContain('wave-status waiting');
    expect(lastExecCall).toContain("'need human review'");
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toBe('waiting');
  });

  test('happy_path — escapes single quotes in reason', async () => {
    await handler.execute({ reason: "BJ's approval" });
    expect(lastExecCall).toContain("'BJ'\\''s approval'");
  });

  test('cli_error — returns ok:false on non-zero exit', async () => {
    execMockFn = () => {
      throw new Error('wave-status: cannot transition');
    };
    const result = await handler.execute({ reason: 'test' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('cannot transition');
  });

  test('schema_validation — rejects missing reason', async () => {
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });

  test('schema_validation — rejects empty reason', async () => {
    const result = await handler.execute({ reason: '' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });
});
