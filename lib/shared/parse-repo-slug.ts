/**
 * Repo slug parsing from the cwd's git remote.
 *
 * Handles SSH and HTTPS remote formats, including deeply nested GitLab group
 * paths. The single source of truth for slug parsing — handlers and adapters
 * import from here rather than rolling local copies.
 *
 * Moved from `lib/glab.ts` per R-17 (Story 1.2). `lib/glab.ts` re-exports
 * these functions during the transition; final deletion of the re-exports
 * happens in Phase 3.
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
export function parseRepoSlug(): string | null {
  try {
    const url = execSync('git remote get-url origin', { encoding: 'utf8' }).trim();
    const m = /(?:git@[^:]+:|https?:\/\/[^/]+\/)(.+?)(?:\.git)?$/.exec(url);
    if (m) return m[1];
    return null;
  } catch {
    return null;
  }
}
