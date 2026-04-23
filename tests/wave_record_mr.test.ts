import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';

let lastExecCall = '';
let execMockFn: (cmd: string) => string = () => 'mr recorded\n';

const mockExecSync = mock((cmd: string, _opts?: unknown) => {
  lastExecCall = cmd;
  return execMockFn(cmd);
});

mock.module('child_process', () => ({ execSync: mockExecSync }));

const { default: handler } = await import('../handlers/wave_record_mr.ts');

function resetMocks() {
  lastExecCall = '';
  execMockFn = () => 'mr recorded\n';
  mockExecSync.mockClear();
}

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe('wave_record_mr handler', () => {
  beforeEach(resetMocks);
  afterEach(resetMocks);

  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('wave_record_mr');
    expect(typeof handler.execute).toBe('function');
  });

  test('happy_path — invokes wave-status record-mr with issue + mr ref', async () => {
    const result = await handler.execute({
      issue_number: 42,
      mr_ref: '#99',
    });
    expect(lastExecCall).toContain('wave-status record-mr 42');
    expect(lastExecCall).toContain("'#99'");
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toBe('mr recorded');
  });

  test('happy_path — handles URL-style mr_ref', async () => {
    await handler.execute({
      issue_number: 5,
      mr_ref: 'https://github.com/org/repo/pull/42',
    });
    expect(lastExecCall).toContain('wave-status record-mr 5');
    expect(lastExecCall).toContain("'https://github.com/org/repo/pull/42'");
  });

  test('cli_error — returns ok:false on non-zero exit', async () => {
    execMockFn = () => {
      throw new Error('wave-status: no current wave is set');
    };
    const result = await handler.execute({ issue_number: 1, mr_ref: '#1' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('no current wave');
  });

  test('schema_validation — rejects missing issue_number AND issue_ref', async () => {
    const result = await handler.execute({ mr_ref: '#1' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });

  test('issue_ref_uses_qualified_ref_in_CLI', async () => {
    const result = await handler.execute({
      issue_ref: 'Wave-Engineering/sdlc#185',
      mr_ref: '#42',
    });
    expect(lastExecCall).toContain('wave-status record-mr');
    expect(lastExecCall).toContain("'Wave-Engineering/sdlc#185'");
    // Should NOT degrade to a bare number.
    expect(lastExecCall).not.toMatch(/wave-status record-mr 185 /);
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
  });

  test('issue_ref — accepts bare-number ref', async () => {
    await handler.execute({ issue_ref: '185', mr_ref: '#1' });
    expect(lastExecCall).toContain("'185'");
  });

  test('issue_number_fallback — bare number still works when issue_ref absent', async () => {
    const result = await handler.execute({ issue_number: 42, mr_ref: '#99' });
    expect(lastExecCall).toContain('wave-status record-mr 42');
    expect(lastExecCall).toContain("'#99'");
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
  });

  test('issue_ref — rejects malformed ref', async () => {
    const result = await handler.execute({ issue_ref: 'not a ref', mr_ref: '#1' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });

  test('schema_validation — rejects missing mr_ref', async () => {
    const result = await handler.execute({ issue_number: 1 });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });

  test('schema_validation — rejects empty mr_ref', async () => {
    const result = await handler.execute({ issue_number: 1, mr_ref: '' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });
});
