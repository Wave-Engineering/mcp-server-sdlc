import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  installChildProcessMock,
  setExecMock,
  resetExecMock,
  execCalls,
} from '../lib/test-support/mock-child-process.ts';

installChildProcessMock();

const { default: handler } = await import('../handlers/wave_waiting.ts');

function resetMocks() {
  resetExecMock();
  setExecMock(() => 'waiting\n');
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
    expect(execCalls().at(-1) ?? '').toContain('wave-status waiting');
    expect(execCalls().at(-1) ?? '').toContain("'need human review'");
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toBe('waiting');
  });

  test('happy_path — escapes single quotes in reason', async () => {
    await handler.execute({ reason: "BJ's approval" });
    expect(execCalls().at(-1) ?? '').toContain("'BJ'\\''s approval'");
  });

  test('cli_error — returns ok:false on non-zero exit', async () => {
    setExecMock(() => {
      throw new Error('wave-status: cannot transition');
    });
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
