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

/** A branch head on the `origin` remote: its short name plus the SHA it points at. */
export interface RemoteBranch {
  name: string;
  sha: string;
}

/**
 * Local branch names matching `<pattern>` via `git branch --list <pattern>`.
 * The pattern is passed to git verbatim (shell-escaped, so the shell never
 * globs it) — git does its own matching. Returns `[]` on any non-zero exit.
 * Strips git's `* `/`+ ` current/worktree markers and surrounding whitespace.
 */
export function listLocalBranches(cwd: string, pattern: string): string[] {
  const result = runArgv(['git', 'branch', '--list', pattern], cwd);
  if (result.exitCode !== 0) return [];
  return result.stdout
    .split('\n')
    .map(line => line.replace(/^[*+]?\s*/, '').trim())
    .filter(Boolean);
}

/**
 * Remote branch heads matching `<pattern>` via
 * `git ls-remote --heads origin <pattern>`. Each line is `<sha>\trefs/heads/<name>`;
 * we return `{ name, sha }` with the `refs/heads/` prefix stripped. `[]` on
 * non-zero exit.
 */
export function listRemoteBranches(cwd: string, pattern: string): RemoteBranch[] {
  const result = runArgv(['git', 'ls-remote', '--heads', 'origin', pattern], cwd);
  if (result.exitCode !== 0) return [];
  return result.stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const [sha, ref] = line.split(/\s+/);
      return { sha: sha ?? '', name: (ref ?? '').replace(/^refs\/heads\//, '') };
    })
    .filter(b => b.name.length > 0);
}

/**
 * True when `<ref>` is an ancestor of `<base>` — i.e. `ref` has already been
 * merged into `base` — via `git merge-base --is-ancestor <ref> <base>` (exit 0).
 * Any non-zero exit (not an ancestor, unknown ref, base absent) collapses to
 * `false`. Callers treat `false` as "not yet merged", the conservative default.
 */
export function isAncestor(cwd: string, ref: string, base: string): boolean {
  // `--` forces ref/base to be read as commit operands, so a ref that happens to
  // begin with `-` is looked up as an object name rather than parsed as a git
  // option (belt-and-suspenders — every token is already shell-escaped upstream).
  return runArgv(['git', 'merge-base', '--is-ancestor', '--', ref, base], cwd).exitCode === 0;
}
