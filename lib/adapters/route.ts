/**
 * Dispatch layer — `getAdapter()` returns the `PlatformAdapter` for the
 * current execution context.
 *
 * When a `repo` slug is provided with 3+ segments (e.g. `org/sub/repo`),
 * the slug structure is unambiguously GitLab (GitHub only supports flat
 * `owner/repo`). For 2-segment slugs the platform is ambiguous, so we
 * fall back to cwd-based detection via `detectPlatform()`.
 *
 * `platformFor()` is that inference, exported so a handler that also needs
 * the platform NAME (e.g. to normalize raw run statuses) takes it from the
 * same place the adapter came from. A handler that takes `repo` must never
 * call `detectPlatform()` itself: cwd detection ignores `repo`, so it can
 * name a different platform than the adapter that did the fetching (#603).
 * `scripts/ci/gate-greps.sh` enforces this.
 *
 * Sync because `detectPlatform()` is sync (CT-03 — current behavior preserved
 * during the retrofit).
 */

import { detectPlatform, type Platform } from '../shared/detect-platform.js';
import { githubAdapter } from './github.js';
import { gitlabAdapter } from './gitlab.js';
import type { PlatformAdapter } from './types.js';

/**
 * The platform a call about `args.repo` targets: GitLab for a nested-group
 * slug (3+ segments), otherwise the cwd origin's platform.
 */
export function platformFor(args?: { repo?: string }): Platform {
  const repo = args?.repo;
  if (repo && repo.split('/').length > 2) return 'gitlab';
  return detectPlatform();
}

/** The adapter for an already-resolved platform. */
export function adapterFor(platform: Platform): PlatformAdapter {
  return platform === 'gitlab' ? gitlabAdapter : githubAdapter;
}

export function getAdapter(args?: { repo?: string }): PlatformAdapter {
  return adapterFor(platformFor(args));
}
