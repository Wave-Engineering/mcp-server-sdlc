/**
 * Platform detection — cwd-based and ref-based.
 *
 * The single source of truth for whether the current repo (or a qualified
 * issue ref) lives on GitHub or GitLab. Handlers and adapters import from
 * here rather than rolling local copies — a prior local copy in `pr_list.ts`
 * inverted the check (`url.includes('github')`) which gives the wrong answer
 * for self-hosted enterprise deployments.
 *
 * Moved from `lib/glab.ts` per R-17 (Story 1.2). `lib/glab.ts` re-exports
 * these functions during the transition; final deletion of the re-exports
 * happens in Phase 3.
 */

import { execSync } from 'child_process';
import type { IssueRef } from '../spec_parser.js';

export type Platform = 'github' | 'gitlab';

/**
 * Detect whether the current repo's origin is a GitLab or GitHub remote.
 *
 * Returns `'gitlab'` if the origin URL contains `'gitlab'` (matches gitlab.com
 * and any self-hosted `gitlab.<company>.com`), otherwise `'github'`. Falls
 * back to `'github'` if the origin cannot be read.
 */
export function detectPlatform(): Platform {
  try {
    const url = execSync('git remote get-url origin', { encoding: 'utf8' }).trim();
    return url.includes('gitlab') ? 'gitlab' : 'github';
  } catch {
    return 'github';
  }
}

/**
 * Detect platform for a qualified issue ref (`owner/repo#N`).
 *
 * When a ref includes an owner path, we can infer the platform:
 * - If the owner has multiple segments (e.g. `org/sub/group`), it MUST be
 *   GitLab — GitHub only supports single-segment owners.
 * - Otherwise, fall back to cwd-based detection (ambiguous).
 *
 * When a ref is local (no owner/repo), falls back to cwd-based detection.
 */
export function detectPlatformForRef(ref: IssueRef): Platform {
  if (ref.owner && ref.owner.includes('/')) {
    return 'gitlab';
  }
  return detectPlatform();
}
