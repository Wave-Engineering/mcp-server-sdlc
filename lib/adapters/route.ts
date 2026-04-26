/**
 * Dispatch layer — `getAdapter()` returns the `PlatformAdapter` for the
 * current execution context (cwd-based detection by default; an optional
 * `repo` arg is reserved for future cross-repo dispatch).
 *
 * Sync because `detectPlatform()` is sync (CT-03 — current behavior preserved
 * during the retrofit).
 */

import { detectPlatform } from '../shared/detect-platform.js';
import { githubAdapter } from './github.js';
import { gitlabAdapter } from './gitlab.js';
import type { PlatformAdapter } from './types.js';

// `args.repo` is accepted today for forward-compat with the §5.4 spec but
// not yet consumed — current behavior delegates to cwd-based `detectPlatform()`.
// Cross-repo dispatch lands when an upcoming story (Phase 2) extends
// `detectPlatform` to accept a repo slug; this signature won't change.
export function getAdapter(_args?: { repo?: string }): PlatformAdapter {
  const platform = detectPlatform();
  return platform === 'gitlab' ? gitlabAdapter : githubAdapter;
}
