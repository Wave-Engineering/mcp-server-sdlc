import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import {
  setExecMock,
  resetExecMock,
  execCalls,
  installChildProcessMock,
} from '../lib/test-support/mock-child-process.ts';

const mockWriteFileSync = mock((_path: unknown, _data: unknown) => undefined);

installChildProcessMock();
mock.module('fs', () => ({ writeFileSync: mockWriteFileSync }));

const { default: handler } = await import('../handlers/wave_flight_plan.ts');

function resetMocks() {
  resetExecMock();
  setExecMock(() => 'flight plan stored\n');
  mockWriteFileSync.mockClear();
}

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe('wave_flight_plan handler', () => {
  beforeEach(resetMocks);
  afterEach(resetMocks);

  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('wave_flight_plan');
    expect(typeof handler.execute).toBe('function');
  });

  test('happy_path — writes plan to temp file and invokes wave-status flight-plan', async () => {
    const planJson = JSON.stringify([{ issues: [5, 6], status: 'pending' }]);
    const result = await handler.execute({ plan_json: planJson });
    expect(mockWriteFileSync.mock.calls.length).toBe(1);
    const writtenPath = mockWriteFileSync.mock.calls[0][0] as string;
    expect(writtenPath).toMatch(/^\/tmp\/wave-flight-plan-/);
    expect(mockWriteFileSync.mock.calls[0][1]).toBe(planJson);
    const lastExecCall = execCalls()[execCalls().length - 1] ?? '';
    expect(lastExecCall).toContain('wave-status flight-plan');
    expect(lastExecCall).toContain(writtenPath);
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toBe('flight plan stored');
  });

  test('cli_error — returns ok:false on non-zero exit', async () => {
    setExecMock(() => {
      throw new Error('wave-status: no current wave');
    });
    const result = await handler.execute({ plan_json: '[]' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('no current wave');
  });

  test('schema_validation — rejects missing plan_json', async () => {
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });

  test('schema_validation — rejects empty plan_json string', async () => {
    const result = await handler.execute({ plan_json: '' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });
});
