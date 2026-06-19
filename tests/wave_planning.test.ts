import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  installChildProcessMock,
  setExecMock,
  resetExecMock,
  execCalls,
  mockExecSync,
} from '../lib/test-support/mock-child-process.ts';

installChildProcessMock();

const { default: handler } = await import('../handlers/wave_planning.ts');

function resetMocks() {
  resetExecMock();
  setExecMock(() => 'planning ok\n');
}

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe('wave_planning handler', () => {
  beforeEach(resetMocks);
  afterEach(resetMocks);

  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('wave_planning');
    expect(typeof handler.description).toBe('string');
    expect(handler.description.length).toBeGreaterThan(0);
    expect(typeof handler.execute).toBe('function');
  });

  test('happy_path — invokes wave-status planning', async () => {
    const result = await handler.execute({});
    expect(mockExecSync.mock.calls.length).toBe(1);
    expect(execCalls()[0]).toBe('wave-status planning');
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toBe('planning ok');
  });

  test('cli_error — returns ok:false on non-zero exit, does not throw', async () => {
    setExecMock(() => {
      throw new Error('wave-status: cannot enter planning');
    });
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('cannot enter planning');
  });

  test('schema_validation — rejects unknown input fields', async () => {
    const result = await handler.execute({ wave: 'foo' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });
});
