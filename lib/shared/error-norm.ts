/**
 * Subprocess error normalization — convert `child_process.execSync`'s
 * exception-on-non-zero contract into the result-bag shape adapter code
 * consumes uniformly.
 *
 * `execSync` throws on non-zero exit; the thrown error has `.status`,
 * `.stdout`, `.stderr` properties (Buffer or string). This module wraps
 * the throw into a typed `RunResult` so adapter code can branch on
 * `exitCode` without try/catch noise at every call site.
 *
 * Extracted from `pr_merge.ts` / `pr_create.ts` per Story 1.3.
 */

import { execSync } from 'child_process';
import { shellEscape } from './shell-escape.js';

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ExecError extends Error {
  stdout?: Buffer | string;
  stderr?: Buffer | string;
  status?: number;
}

export function bufToString(b: unknown): string {
  if (b === undefined || b === null) return '';
  if (typeof b === 'string') return b;
  if (typeof (b as Buffer).toString === 'function') return (b as Buffer).toString();
  return String(b);
}

/**
 * Build a single shell command from an argv array (each element shell-escaped)
 * and run it via `execSync`. Returns a `RunResult` on success or non-zero exit;
 * never throws.
 *
 * `cwd` is required so adapter callers can run against a project directory
 * passed in via the `CLAUDE_PROJECT_DIR` env or `process.cwd()` fallback.
 */
export function runArgv(cmd: string[], cwd: string): RunResult {
  const shellCmd = cmd.map(shellEscape).join(' ');
  try {
    const stdout = execSync(shellCmd, { cwd, encoding: 'utf8' });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as ExecError;
    return {
      exitCode: typeof e.status === 'number' ? e.status : -1,
      stdout: bufToString(e.stdout),
      stderr: bufToString(e.stderr) || (err instanceof Error ? err.message : String(err)),
    };
  }
}
