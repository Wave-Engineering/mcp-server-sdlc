/**
 * GitLab `fetchCiTrustSignal` adapter implementation — the GitLab half of the
 * Story 2.24 (#318) hybrid sub-call, the FINAL Phase 2 migration.
 *
 * Lifted from `handlers/wave_ci_trust_level.ts`'s `checkGitlabTrust` helper.
 * `merge_trains_enabled` is the lone pre-merge-authoritative signal on
 * GitLab — merge pipelines alone are not sufficient (they still allow merge
 * before CI completes).
 *
 * Uses the typed `gitlabApiRepo` wrapper from `lib/glab.ts` (the supported
 * path until Phase-3 Story 3.1 deletes `lib/glab.ts`).
 */

import { gitlabApiRepo } from '../glab.js';
import type {
  AdapterResult,
  CiTrustSignal,
  FetchCiTrustSignalArgs,
} from './types.js';

export function fetchCiTrustSignalGitlabSync(
  // repo arg reserved for forward-compat with cross-repo dispatch — the
  // current `gitlabApiRepo()` wrapper resolves the slug from cwd.
  _repo?: string,
): CiTrustSignal {
  const info = gitlabApiRepo();
  if (info.merge_trains_enabled === true) {
    return {
      level: 'pre_merge_authoritative',
      reason: 'gitlab merge trains enabled',
    };
  }
  return {
    level: 'post_merge_required',
    reason: 'gitlab without merge trains',
  };
}

export async function fetchCiTrustSignalGitlab(
  args: FetchCiTrustSignalArgs,
): Promise<AdapterResult<CiTrustSignal>> {
  // Bound any exception (subprocess failure, JSON parse error) into a typed
  // result — adapter callers must not have to try/catch.
  try {
    const data = fetchCiTrustSignalGitlabSync(args.repo);
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      code: 'glab_ci_trust_failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
