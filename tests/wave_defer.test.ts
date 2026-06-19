import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { installChildProcessMock, setExecMock, resetExecMock, execCalls } from '../lib/test-support/mock-child-process.ts';

installChildProcessMock();

const { default: handler } = await import('../handlers/wave_defer.ts');

function resetMocks() {
  resetExecMock();
  setExecMock(() => 'deferral recorded\n');
}

function lastExec(): string {
  return execCalls().at(-1) ?? '';
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
    expect(lastExec()).toContain('wave-status defer');
    expect(lastExec()).toContain("'flaky test'");
    expect(lastExec()).toContain(' low');
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toBe('deferral recorded');
  });

  test('happy_path — accepts medium and high risk', async () => {
    await handler.execute({ description: 'a', risk: 'medium' });
    expect(lastExec()).toContain(' medium');
    await handler.execute({ description: 'b', risk: 'high' });
    expect(lastExec()).toContain(' high');
  });

  test('cli_error — returns ok:false on non-zero exit', async () => {
    setExecMock(() => {
      throw new Error('wave-status: invalid risk');
    });
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
