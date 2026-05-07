// Sanctioned anxiety outlet for idle agents (issue #414).
//
// When a wave-pattern Orchestrator (or Prime) has dispatched work and is
// supposed to wait for filesystem-bus artifacts to appear, it has nothing
// to call. Idle loops without a sanctioned tool drive anxious agents to
// invent polling, hallucinate completions, or exit prematurely. This tool
// exists so the model has something legitimate to call while it waits.
//
// Behavior: poll `signal_path` (literal path or glob) every 5s until at
// least `min_count` matches exist, or `timeout_sec` elapses. On match,
// return `{ matched: [...paths], elapsed_sec: N }`. On timeout, return
// `{ timed_out: true, elapsed_sec: timeout_sec, partial_matches: [...] }`.

import { Glob } from 'bun';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';

export const POLL_INTERVAL_SEC = 5;

const inputSchema = z
  .object({
    signal_path: z.string().min(1, 'signal_path must be a non-empty string'),
    timeout_sec: z.number().int().positive().optional().default(1800),
    min_count: z.number().int().positive().optional().default(1),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

function envelope(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

/**
 * Resolve `signal_path` to a list of currently-matching filesystem paths.
 *
 * Two modes:
 *   - If the path contains a glob metacharacter (`*`, `?`, `[`), use Bun.Glob
 *     against the project root and return matching files.
 *   - Otherwise treat as a literal path; return [path] if it exists, else [].
 *
 * Glob patterns are rooted at projectDir() so that callers can pass relative
 * patterns like `wavebus/<wave_id>/flights/*.done`.
 */
export function matchSignal(signalPath: string, cwd: string = projectDir()): string[] {
  // We use Bun.Glob exclusively (not node:fs) because other tests in this
  // codebase call `mock.module('fs', ...)` and the mock leaks across the
  // shared Bun test-runner module space, leaving `existsSync` etc.
  // undefined for this handler. Bun.Glob handles both literal paths
  // (no metacharacters → matches iff the file exists) and patterns
  // uniformly.
  const isAbsolute = signalPath.startsWith('/');
  const scanCwd = isAbsolute ? '/' : cwd;
  const pattern = isAbsolute ? signalPath.slice(1) : signalPath;
  const results: string[] = [];
  for (const match of new Glob(pattern).scanSync({
    cwd: scanCwd,
    absolute: true,
    onlyFiles: false,
  })) {
    results.push(match);
  }
  return results.sort();
}

export interface WaitDeps {
  matchFn: (signalPath: string) => string[];
  sleepFn: (ms: number) => Promise<void>;
  nowFn: () => number;
}

export interface WaitResult {
  ok: true;
  matched?: string[];
  elapsed_sec?: number;
  timed_out?: true;
  partial_matches?: string[];
}

/**
 * Test seam — drives the polling loop with injected dependencies so unit
 * tests can avoid real wall-clock waits and real filesystem state.
 */
export async function __runWithDeps(rawArgs: unknown, deps: Partial<WaitDeps>): Promise<WaitResult> {
  const args = inputSchema.parse(rawArgs) as Input;
  const fullDeps: WaitDeps = {
    matchFn: deps.matchFn ?? ((p) => matchSignal(p)),
    sleepFn: deps.sleepFn ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    nowFn: deps.nowFn ?? (() => Date.now()),
  };
  return runWaitLoop(args, fullDeps);
}

async function runWaitLoop(args: Input, deps: WaitDeps): Promise<WaitResult> {
  const startMs = deps.nowFn();
  const timeoutMs = args.timeout_sec * 1000;
  const intervalMs = POLL_INTERVAL_SEC * 1000;

  // Check immediately so callers whose artifacts already exist return
  // without an opening 5s sleep.
  let matches = deps.matchFn(args.signal_path);
  if (matches.length >= args.min_count) {
    return {
      ok: true,
      matched: matches,
      elapsed_sec: Math.round((deps.nowFn() - startMs) / 1000),
    };
  }

  while (deps.nowFn() - startMs < timeoutMs) {
    await deps.sleepFn(intervalMs);
    matches = deps.matchFn(args.signal_path);
    if (matches.length >= args.min_count) {
      return {
        ok: true,
        matched: matches,
        elapsed_sec: Math.round((deps.nowFn() - startMs) / 1000),
      };
    }
  }

  return {
    ok: true,
    timed_out: true,
    elapsed_sec: args.timeout_sec,
    partial_matches: matches,
  };
}

const waveWaitForSignalHandler: HandlerDef = {
  name: 'wave_wait_for_signal',
  description:
    'Block until min_count filesystem artifacts matching signal_path exist, or timeout_sec elapses. Sanctioned idle-wait for wave-pattern Orchestrators waiting on Flight completion artifacts.',
  inputSchema,
  async execute(rawArgs: unknown) {
    let args: Input;
    try {
      args = inputSchema.parse(rawArgs) as Input;
    } catch (err) {
      return envelope({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }

    try {
      const result = await runWaitLoop(args, {
        matchFn: (p) => matchSignal(p),
        sleepFn: (ms) => new Promise((r) => setTimeout(r, ms)),
        nowFn: () => Date.now(),
      });
      return envelope(result);
    } catch (err) {
      return envelope({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  },
};

export default waveWaitForSignalHandler;
