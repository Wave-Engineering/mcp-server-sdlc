/**
 * Dispatch layer — `getAdapter()` returns the `PlatformAdapter` for the
 * current execution context.
 *
 * When a `repo` slug is provided with 3+ segments (e.g. `org/sub/repo`),
 * the slug structure is unambiguously GitLab (GitHub only supports flat
 * `owner/repo`). For 2-segment slugs the platform is ambiguous, so we
 * fall back to cwd-based detection via `detectPlatform()`.
 *
 * Sync because `detectPlatform()` is sync (CT-03 — current behavior preserved
 * during the retrofit).
 */

import { detectPlatform } from '../shared/detect-platform.js';
import { githubAdapter } from './github.js';
import { gitlabAdapter } from './gitlab.js';
import type { PlatformAdapter } from './types.js';

export function getAdapter(args?: { repo?: string }): PlatformAdapter {
  const platform = inferPlatform(args?.repo);
  return platform === 'gitlab' ? gitlabAdapter : githubAdapter;
}

function inferPlatform(repo?: string) {
  if (repo) {
    const segments = repo.split('/').length;
    if (segments > 2) return 'gitlab' as const;
  }
  return detectPlatform();
}
