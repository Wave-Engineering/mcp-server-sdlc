/**
 * Shared `child_process.execSync` mock for the unit test suite.
 *
 * WHY THIS EXISTS — the load-order flake (#455)
 * ---------------------------------------------
 * Bun's `mock.module()` writes to a PROCESS-GLOBAL module registry. When every
 * test file installs its OWN `mock.module('child_process', ...)`, the last file
 * to register before a shared source is imported wins — and that source stays
 * import-cached, bound to the winner's mock. A statically/dynamically imported
 * shared module (e.g. `lib/shared/parse-repo-slug.ts`, the fetch-ci-trust
 * adapters) therefore ends up calling a FOREIGN file's `execSync`, which has no
 * responder for the victim's commands. The victim flakes — CI-only, because the
 * load order that triggers it differs from local runs.
 *
 * THE FIX
 * -------
 * Every test file installs THIS single shared mock over shared state. The mock
 * delegates to a swappable `responder`, so the global binding always routes to
 * whichever test file is currently running: Bun runs files sequentially, and
 * each file points the responder at its own logic on entry (`beforeEach`).
 * "Last writer wins" on the global registry becomes a no-op instead of a leak,
 * because every writer installs the same function over the same state.
 *
 * TWO IDIOMS, BOTH SUPPORTED
 * --------------------------
 *  - registry idiom: `onExec(match, respond)` builds a substring→response table;
 *    an unmatched command throws (loud, surfaces missing stubs).
 *  - responder idiom: `setExecMock(fn)` swaps the whole responder for a per-test
 *    function (carries its own unmatched default, typically lenient).
 *
 * Both reset via `resetExecMock()` in `beforeEach` (and `afterEach` where the
 * original file had one).
 */
import { mock } from 'bun:test';

export type ExecResponder = (cmd: string) => string;

interface ThrowableError extends Error {
  stderr?: string;
  stdout?: string;
  status?: number;
}

type RegistryResponder = string | ((cmd: string) => string);

let registry: Array<{ match: string; respond: RegistryResponder }> = [];
let responder: ExecResponder | null = null;
let calls: string[] = [];
let callsDetailed: Array<{ cmd: string; opts: unknown }> = [];

/** Strip single-quotes so `match` can ignore shell quoting (registry idiom). */
function unquote(cmd: string): string {
  return cmd.replace(/'([^']*)'/g, '$1');
}

/** Default responder: walk the registry; an unmatched command throws loudly. */
function registryResponder(cmd: string): string {
  const flat = unquote(cmd);
  for (const { match, respond } of registry) {
    if (cmd.includes(match) || flat.includes(match)) {
      return typeof respond === 'function' ? respond(cmd) : respond;
    }
  }
  const err = new Error(`Unexpected exec: ${cmd}`) as ThrowableError;
  err.stderr = `Unexpected exec: ${cmd}`;
  err.status = 127;
  throw err;
}

/**
 * The shared `execSync` mock. Install it with {@link installChildProcessMock};
 * read recorded commands with {@link execCalls}.
 */
export const mockExecSync = mock((cmd: string, opts?: unknown): string => {
  calls.push(cmd);
  callsDetailed.push({ cmd, opts });
  return (responder ?? registryResponder)(cmd);
});

/**
 * Install the shared `child_process` mock. Idempotent across files — every file
 * registers the SAME function over the SAME state. Call at module top level,
 * BEFORE the file's dynamic `await import()` of its source-under-test.
 */
export function installChildProcessMock(): void {
  mock.module('child_process', () => ({ execSync: mockExecSync }));
}

/** responder idiom: swap the whole responder for a per-test function. */
export function setExecMock(fn: ExecResponder): void {
  responder = fn;
}

/** registry idiom: register a substring→response rule (unmatched throws). */
export function onExec(match: string, respond: RegistryResponder): void {
  registry.push({ match, respond });
}

/** Per-test reset — call in `beforeEach` (and `afterEach` where used). */
export function resetExecMock(): void {
  registry = [];
  responder = null;
  calls = [];
  callsDetailed = [];
  mockExecSync.mockClear();
}

/** Recorded commands, in call order — for files that asserted on exec calls. */
export function execCalls(): string[] {
  return calls;
}

/**
 * Recorded calls with their `opts` argument (e.g. `{ cwd }`), in call order —
 * for files that asserted on the second arg passed to `execSync`. The shared
 * mock also exposes Bun's native `mockExecSync.mock.calls` if needed.
 */
export function execCallsDetailed(): Array<{ cmd: string; opts: unknown }> {
  return callsDetailed;
}
