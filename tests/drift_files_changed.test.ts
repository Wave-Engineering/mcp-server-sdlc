import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  installChildProcessMock,
  setExecMock,
  resetExecMock,
  execCalls,
} from '../lib/test-support/mock-child-process.ts';

installChildProcessMock();

const { default: handler } = await import('../handlers/drift_files_changed.ts');

function lastExecCall(): string {
  const c = execCalls();
  return c[c.length - 1] ?? '';
}

function resetMocks() {
  resetExecMock();
  setExecMock(() => '');
}

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe('drift_files_changed handler', () => {
  beforeEach(resetMocks);
  afterEach(resetMocks);

  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('drift_files_changed');
    expect(typeof handler.execute).toBe('function');
  });

  test('basic_diff — returns parsed file list', async () => {
    setExecMock(() => 'src/foo.ts\nsrc/bar.ts\nREADME.md\n');
    const result = await handler.execute({ from_ref: 'abc123', to_ref: 'def456' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.files).toEqual(['src/foo.ts', 'src/bar.ts', 'README.md']);
    expect(parsed.count).toBe(3);
    expect(lastExecCall()).toContain('git diff --name-only');
    expect(lastExecCall()).toContain("'abc123'");
    expect(lastExecCall()).toContain("'def456'");
  });

  test('default_to_head — to_ref defaults to HEAD when omitted', async () => {
    setExecMock(() => 'a.ts\n');
    await handler.execute({ from_ref: 'main' });
    expect(lastExecCall()).toContain("'main'..'HEAD'");
  });

  test('empty_diff — no changes returns empty list', async () => {
    setExecMock(() => '');
    const result = await handler.execute({ from_ref: 'main', to_ref: 'HEAD' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.files).toEqual([]);
    expect(parsed.count).toBe(0);
  });

  test('invalid_ref_returns_error — structured error, does not throw', async () => {
    setExecMock(() => {
      throw new Error("fatal: bad revision 'nonexistent'");
    });
    const result = await handler.execute({ from_ref: 'nonexistent' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('bad revision');
  });

  test('schema_validation — rejects missing from_ref', async () => {
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });

  test('schema_validation — rejects empty from_ref', async () => {
    const result = await handler.execute({ from_ref: '' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });
});
