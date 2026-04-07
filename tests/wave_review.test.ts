import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';

let lastExecCall = '';
let execMockFn: (cmd: string) => string = () => 'review phase\n';

const mockExecSync = mock((cmd: string, _opts?: unknown) => {
  lastExecCall = cmd;
  return execMockFn(cmd);
});

mock.module('child_process', () => ({ execSync: mockExecSync }));

const { default: handler } = await import('../handlers/wave_review.ts');

function resetMocks() {
  lastExecCall = '';
  execMockFn = () => 'review phase\n';
  mockExecSync.mockClear();
}

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe('wave_review handler', () => {
  beforeEach(resetMocks);
  afterEach(resetMocks);

  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('wave_review');
    expect(typeof handler.execute).toBe('function');
  });

  test('happy_path — invokes wave-status review', async () => {
    const result = await handler.execute({});
    expect(lastExecCall).toBe('wave-status review');
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toBe('review phase');
  });

  test('cli_error — returns ok:false on non-zero exit', async () => {
    execMockFn = () => {
      throw new Error('wave-status: cannot enter review from current state');
    };
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('cannot enter review');
  });

  test('schema_validation — rejects unknown fields', async () => {
    const result = await handler.execute({ wave: 'foo' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });
});
