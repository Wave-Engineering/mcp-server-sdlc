/**
 * Repo slug parsing from the cwd's git remote.
 *
 * Handles SSH and HTTPS remote formats, including deeply nested GitLab group
 * paths. The single source of truth for slug parsing — handlers and adapters
 * import from here rather than rolling local copies.
 *
 * Moved here per R-17 (Story 1.2) — the single source of truth for slug
 * parsing lives in `lib/shared/`, and GitLab-specific REST wrappers live
 * in `lib/gitlab-api.ts`.
 */

import { execSync } from 'child_process';

/**
 * Parse the project slug from the current repo's origin URL.
 *
 * Handles both SSH (`git@host:path.git`) and HTTPS
 * (`https://host/path(.git)?`) remote formats, including deeply nested
 * GitLab group paths (e.g. `org/sub/group/repo`). Returns `null` if the
 * origin cannot be read or the URL does not match the expected pattern.
 */
export function parseRepoSlug(cwd?: string): string | null {
  try {
    // `cwd` defaults to undefined → `process.cwd()`, identical to pre-#453
    // behavior for every existing caller. Callers that thread an explicit cwd
    // resolve the slug from THAT repo's origin (e.g. wave_finalize against a
    // worktree != CLAUDE_PROJECT_DIR).
    const url = execSync('git remote get-url origin', { encoding: 'utf8', cwd }).trim();
    const m = /(?:git@[^:]+:|https?:\/\/[^/]+\/)(.+?)(?:\.git)?$/.exec(url);
    if (m) return m[1];
    return null;
  } catch {
    return null;
  }
}
