import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';

let lastExecCall = '';
let execMockFn: (cmd: string) => string = () => 'issue closed\n';

const mockExecSync = mock((cmd: string, _opts?: unknown) => {
  lastExecCall = cmd;
  return execMockFn(cmd);
});

mock.module('child_process', () => ({ execSync: mockExecSync }));

const { default: handler } = await import('../handlers/wave_close_issue.ts');

function resetMocks() {
  lastExecCall = '';
  execMockFn = () => 'issue closed\n';
  mockExecSync.mockClear();
}

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe('wave_close_issue handler', () => {
  beforeEach(resetMocks);
  afterEach(resetMocks);

  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('wave_close_issue');
    expect(typeof handler.execute).toBe('function');
  });

  test('happy_path — invokes wave-status close-issue with N', async () => {
    const result = await handler.execute({ issue_number: 42 });
    expect(lastExecCall).toBe('wave-status close-issue 42');
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toBe('issue closed');
  });

  test('cli_error — returns ok:false on non-zero exit', async () => {
    execMockFn = () => {
      throw new Error('wave-status: issue #42 does not exist in the plan');
    };
    const result = await handler.execute({ issue_number: 42 });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('does not exist');
  });

  test('schema_validation — rejects missing issue_number', async () => {
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });

  test('schema_validation — rejects non-integer issue_number', async () => {
    const result = await handler.execute({ issue_number: 'abc' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });
});
