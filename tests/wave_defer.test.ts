import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { installChildProcessMock, setExecMock, resetExecMock, execCalls } from '../lib/test-support/mock-child-process.ts';

installChildProcessMock();

const { default: handler } = await import('../handlers/wave_defer.ts');

function resetMocks() {
  resetExecMock();
  // #425: the real `wave-status defer` prints NOTHING on success (it saves state
  // and returns). The previous mock returned 'deferral recorded\n', which
  // masked the empty-output bug this fix addresses — so model reality here.
  setExecMock(() => '');
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

  test('happy_path — invokes wave-status defer and surfaces the recorded deferral (#425)', async () => {
    const result = await handler.execute({
      description: 'flaky test',
      risk: 'low',
    });
    expect(lastExec()).toContain('wave-status defer');
    expect(lastExec()).toContain("'flaky test'");
    expect(lastExec()).toContain(' low');
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    // #425: even though the CLI prints nothing, the response is NOT an empty
    // no-op — it carries the recorded deferral so callers can tell "recorded"
    // from "no-op" without a follow-up wave_show.
    expect(parsed.deferral).toEqual({
      description: 'flaky test',
      risk: 'low',
      status: 'pending',
    });
    expect(parsed.data).not.toBe('');
  });

  test('#425 — empty CLI output no longer surfaces as a bare no-op', async () => {
    // The real `wave-status defer` prints nothing; pre-fix this returned
    // { ok: true, data: "" }, indistinguishable from "nothing happened".
    setExecMock(() => '');
    const parsed = parseResult(await handler.execute({ description: 'x', risk: 'high' }));
    expect(parsed.ok).toBe(true);
    expect(parsed.deferral.status).toBe('pending');
    expect(parsed.deferral.risk).toBe('high');
    expect(parsed.deferral.description).toBe('x');
    // The tell #425 called out — data:"" — is gone.
    expect(parsed.data).not.toBe('');
  });

  test('#425 — a real CLI output, if ever emitted, is preserved in data', async () => {
    // Additive/forward-compatible: if a future wave-status defer prints an
    // envelope, the handler still relays it in `data` rather than discarding it.
    setExecMock(() => 'recorded deferral #3\n');
    const parsed = parseResult(await handler.execute({ description: 'y', risk: 'medium' }));
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toBe('recorded deferral #3');
    expect(parsed.deferral.risk).toBe('medium');
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
