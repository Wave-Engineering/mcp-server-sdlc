/**
 * Deploy-freshness check (#447).
 *
 * "Fixed in source, stale in binary" cost the fleet real debugging time: a
 * deployed `sdlc-server` binary lagged the latest release by four merged fixes,
 * with no signal anywhere — the only symptom was a confusing downstream failure
 * miles from the root cause. (It also fooled ME: I once reasoned from repo source
 * that was five days ahead of the running binary and gave a teammate a confident
 * wrong answer. See the ethos note at the bottom of #447.)
 *
 * This emits a one-time `warn` at startup when the RUNNING binary is behind the
 * server's own latest GitHub release. It is:
 *   - EXACT, not date-heuristic: it asks GitHub's compare API whether the build
 *     commit is an ancestor of the latest release tag.
 *   - NETWORK-OPTIONAL: any failure (offline, no `gh`, no auth, no releases)
 *     degrades silently. It never blocks startup and never throws.
 *   - self-scoped: the check is about the SERVER'S OWN repo (always the GitHub
 *     repo below), independent of whatever project the server is operating on —
 *     so there is no platform ambiguity.
 */

import { log } from '../logger.js';

// The server's own home. The freshness question is always "is this binary behind
// ITS OWN latest release", never about the project under operation.
export const SELF_REPO = 'Wave-Engineering/mcp-server-sdlc';

// Compile-time injected by scripts/ci/build.sh via `bun build --define`. Absent in
// dev/test runs (uncompiled) — `typeof` keeps that reference safe, and a build that
// carries no real SHA is treated as a dev build and skipped (a dev build is never
// "stale" relative to a release).
declare const __BUILD_SHA__: string;
declare const __BUILD_REF__: string;
declare const __BUILD_AT__: string;

export interface BuildInfo {
  sha: string;
  ref: string;
  builtAt: string;
}

export const DEV_SENTINEL = 'dev';

export function getBuildInfo(): BuildInfo {
  return {
    sha: typeof __BUILD_SHA__ === 'undefined' ? DEV_SENTINEL : __BUILD_SHA__,
    ref: typeof __BUILD_REF__ === 'undefined' ? DEV_SENTINEL : __BUILD_REF__,
    builtAt: typeof __BUILD_AT__ === 'undefined' ? DEV_SENTINEL : __BUILD_AT__,
  };
}

/** A real, comparable build carries a 40-char commit SHA. */
function isReleaseComparable(info: BuildInfo): boolean {
  return /^[0-9a-f]{40}$/i.test(info.sha);
}

/** GitHub's `base...head` comparison verdict — `head` relative to `base`. */
export type CompareStatus = 'ahead' | 'behind' | 'identical' | 'diverged';

export interface FreshnessDeps {
  /** Latest release tag name of SELF_REPO, or null on any failure. */
  fetchLatestReleaseTag: () => Promise<string | null>;
  /**
   * GitHub compare status for `base...head`. `ahead` = head has commits base does
   * not (base is behind head). null on any failure.
   */
  compareRefs: (base: string, head: string) => Promise<CompareStatus | null>;
  now?: () => number;
}

/**
 * Run the check. NEVER throws, NEVER blocks — designed to be called
 * fire-and-forget at startup. Returns the emitted warning payload (or null when
 * nothing was warned) purely so tests can assert without scraping stderr.
 */
export async function checkDeployFreshness(
  deps: FreshnessDeps,
): Promise<Record<string, unknown> | null> {
  try {
    const info = getBuildInfo();

    // A dev build (or any build without an embedded commit SHA) is never "behind"
    // a release — there is nothing meaningful to compare. Skip silently.
    if (!isReleaseComparable(info)) return null;

    const tag = await deps.fetchLatestReleaseTag();
    if (!tag) return null; // offline / no releases / no auth → silent

    // base = the running binary's commit, head = the latest release tag.
    // `ahead` means the release has commits the binary does not → binary is BEHIND.
    const status = await deps.compareRefs(info.sha, tag);
    if (status !== 'ahead') return null; // identical / behind (newer dev) / diverged / null → no warn

    const payload = {
      binary_sha: info.sha,
      binary_ref: info.ref,
      binary_built_at: info.builtAt,
      latest_release: tag,
      repo: SELF_REPO,
    };
    log.warn(
      'deploy_freshness',
      payload,
      `sdlc-server binary (${info.sha.slice(0, 8)}, built ${info.builtAt}) is BEHIND the latest release ${tag} — redeploy with ./install --mcps`,
    );
    return payload;
  } catch {
    // Freshness is a courtesy signal; it must never disrupt the server.
    return null;
  }
}
