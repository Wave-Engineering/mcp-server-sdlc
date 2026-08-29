/**
 * Shared `fs` mock for the unit test suite — the `fs` analogue of
 * mock-child-process.ts.
 *
 * WHY THIS EXISTS — the load-order flake (#456, following #455)
 * ------------------------------------------------------------
 * Bun's `mock.module()` writes to a PROCESS-GLOBAL module registry. When every
 * test file installs its OWN `mock.module('fs', ...)`, the last file to register
 * before a shared source is imported wins — and that source stays import-cached,
 * bound to the winner's mock. A statically/dynamically imported module that
 * reaches for `fs`/`node:fs` (e.g. `logger.ts` → `appendFileSync`/`mkdirSync`/
 * `existsSync`, or a handler's `writeFileSync`) therefore ends up calling a
 * FOREIGN file's fs stub, whose exported surface may not even include the symbol
 * the victim needs — surfacing as `Export named 'mkdirSync' not found` or a
 * silently wrong write. This is the identical failure mode that made
 * `child_process` (#455) and `parseRepoSlug` flake; it simply has not hit a
 * victim under the current file-load ordering. This helper closes the latent
 * vector before it becomes a CI-only flake.
 *
 * THE FIX
 * -------
 * Every fs-mocking test file installs THIS single shared mock. Because every
 * writer installs the SAME functions over the SAME state, "last writer wins" on
 * the global registry becomes a no-op instead of a leak. Bun runs files
 * sequentially; each file resets state on entry (`resetFsMock()` in
 * `beforeEach`) and, where needed, swaps individual behaviors via
 * {@link setFsMock}. The exported surface is the UNION of what every converted
 * file needs (`writeFileSync` + the `logger.ts` trio), so a file that only
 * mocked `writeFileSync` gains harmless extra exports rather than losing any.
 *
 * USAGE
 * -----
 *   import {
 *     installFsMock, resetFsMock, mockWriteFileSync,
 *   } from '../lib/test-support/mock-fs.ts';
 *
 *   installFsMock();                       // module top level, BEFORE `await import`
 *   const { default: handler } = await import('../handlers/foo.ts');
 *
 *   beforeEach(resetFsMock);               // per-test isolation
 *   ...
 *   expect(mockWriteFileSync.mock.calls[0][0]).toBe('/tmp/...');
 *
 * Assert on writes via the exported `mockWriteFileSync` bun-mock (its
 * `.mock.calls` array), exactly as a local `mock(...)` would have been used.
 */
import { mock } from 'bun:test';

/** Per-test overrides — swap an individual fs function's behavior. */
export interface FsOverrides {
  writeFileSync?: (path: unknown, data: unknown) => void;
  appendFileSync?: (path: unknown, data: unknown) => void;
  mkdirSync?: (path: unknown, opts?: unknown) => void;
  existsSync?: (path: unknown) => boolean;
}

let overrides: FsOverrides = {};

/**
 * Recording `writeFileSync` mock. Exported so tests can assert on
 * `mockWriteFileSync.mock.calls` (path = call[0], data = call[1]) just like a
 * file-local `mock(...)`. A per-test {@link setFsMock} override runs AFTER the
 * call is recorded, so assertions on recorded args stay valid.
 */
export const mockWriteFileSync = mock((path: unknown, data: unknown): void => {
  overrides.writeFileSync?.(path, data);
  return undefined;
});

export const mockAppendFileSync = mock((path: unknown, data: unknown): void => {
  overrides.appendFileSync?.(path, data);
  return undefined;
});

export const mockMkdirSync = mock((path: unknown, opts?: unknown): void => {
  overrides.mkdirSync?.(path, opts);
  return undefined;
});

/** Defaults to `true` (dir/file present) — the pre-conversion per-file default. */
export const mockExistsSync = mock((path: unknown): boolean => {
  return overrides.existsSync ? overrides.existsSync(path) : true;
});

/**
 * Install the shared `fs` mock. Idempotent across files — every file registers
 * the SAME functions over the SAME state. Call at module top level, BEFORE the
 * file's dynamic `await import()` of its source-under-test. Bun aliases `'fs'`
 * to `'node:fs'`, so both import specifiers resolve to this surface.
 */
export function installFsMock(): void {
  mock.module('fs', () => ({
    writeFileSync: mockWriteFileSync,
    appendFileSync: mockAppendFileSync,
    mkdirSync: mockMkdirSync,
    existsSync: mockExistsSync,
  }));
}

/** Swap one or more fs behaviors for the current test (merges over existing). */
export function setFsMock(o: FsOverrides): void {
  overrides = { ...overrides, ...o };
}

/** Per-test reset — call in `beforeEach` (and `afterEach` where used). */
export function resetFsMock(): void {
  overrides = {};
  mockWriteFileSync.mockClear();
  mockAppendFileSync.mockClear();
  mockMkdirSync.mockClear();
  mockExistsSync.mockClear();
}

/** Recorded `writeFileSync` calls as `{ path, data }`, in call order. */
export function fsWriteCalls(): Array<{ path: unknown; data: unknown }> {
  return mockWriteFileSync.mock.calls.map(c => ({ path: c[0], data: c[1] }));
}
