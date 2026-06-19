import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  installChildProcessMock,
  setExecMock,
  resetExecMock,
  execCalls,
} from '../lib/test-support/mock-child-process.ts';

installChildProcessMock();

const { default: handler } = await import('../handlers/wave_complete.ts');

function resetMocks() {
  resetExecMock();
  setExecMock(() => 'wave complete\n');
}

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe('wave_complete handler', () => {
  beforeEach(resetMocks);
  afterEach(resetMocks);

  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('wave_complete');
    expect(typeof handler.execute).toBe('function');
  });

  test('happy_path — invokes wave-status complete', async () => {
    const result = await handler.execute({});
    expect(execCalls().at(-1)).toBe('wave-status complete');
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toBe('wave complete');
  });

  test('cli_error — returns ok:false on non-zero exit', async () => {
    setExecMock(() => {
      throw new Error('wave-status: no current wave is set');
    });
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('no current wave');
  });

  test('schema_validation — rejects unknown fields', async () => {
    const result = await handler.execute({ wave: 'foo' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });
});
