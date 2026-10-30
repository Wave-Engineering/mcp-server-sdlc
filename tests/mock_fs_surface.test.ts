/**
 * The shared fs mock must keep the real fs surface (#609).
 *
 * `mock.module('fs', …)` is process-global. With the mock exporting only the four
 * functions tests stub, any module first linked after it that imports another
 * name (`flightdeck_emit.ts` imports `readFileSync`) fails with
 * "Export named 'readFileSync' not found in module 'node:fs'", is cached as
 * errored, and fails every later file that imports it. CI hit this on
 * ubuntu-26.04 when a test file began importing handlers/pr_merge.ts.
 */
import { describe, expect, test } from 'bun:test';
import { installFsMock, mockWriteFileSync, resetFsMock } from '../lib/test-support/mock-fs.ts';

installFsMock();

describe('shared fs mock surface (#609)', () => {
  test('a module importing a non-stubbed fs export still links under the mock', async () => {
    const mod = await import('../lib/flightdeck_emit.ts');
    expect(typeof mod.emitStateEvent).toBe('function');
  });

  test('non-stubbed exports are the real functions; stubbed ones stay mocked', async () => {
    resetFsMock();
    const fs = await import('node:fs');
    expect(typeof fs.readFileSync).toBe('function');
    expect(typeof fs.statSync).toBe('function');
    fs.writeFileSync('/nonexistent/should-not-be-written', 'x');
    expect(mockWriteFileSync.mock.calls.length).toBe(1);
  });
});
