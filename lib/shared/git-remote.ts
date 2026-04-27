/**
 * Git-remote helpers — platform-agnostic `git` subprocess probes that don't
 * belong inside the platform adapter (they're local git operations, not
 * GitHub/GitLab API calls).
 *
 * Extracted from the handler-local helpers in `wave_init.ts` /
 * `wave_finalize.ts` per Story 2.22 (#316) so future consumers share one
 * implementation.
 */

import { runArgv } from './error-norm.js';

/**
 * Returns true when `<branch>` is present on the `origin` remote. Uses
 * `git ls-remote --heads origin <branch>` — an exit 0 with non-empty stdout
 * means the ref exists. Any other condition (non-zero exit, empty stdout,
 * network error) collapses to `false`; callers treat that as "not present"
 * and can recover.
 */
export function branchExistsOnRemote(cwd: string, branch: string): boolean {
  const result = runArgv(['git', 'ls-remote', '--heads', 'origin', branch], cwd);
  if (result.exitCode !== 0) return false;
  return result.stdout.trim().length > 0;
}
