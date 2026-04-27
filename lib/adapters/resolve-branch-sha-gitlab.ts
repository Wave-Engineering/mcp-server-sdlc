/**
 * GitLab `resolveBranchSha` adapter implementation — the `ci_wait_run`
 * branch→SHA sub-call (Story 2.19, #313).
 *
 * This is a PERMANENT `platform_unsupported` stub per R-03 typed-asymmetry.
 * Branch→SHA resolution on GitLab isn't a pre-condition for the CI wait —
 * GitLab pipelines attach to branch names directly via the `ref=` query on
 * the pipelines endpoint. The GitHub merge-queue pre-flight that needs this
 * resolution doesn't exist on GitLab (merge trains operate differently).
 *
 * Returning `platform_unsupported` (rather than throwing or returning
 * `{ok: true, data: null}`) is the point of R-03: callers that hit this on
 * a GitLab repo get a TYPED signal that the concept doesn't map, not a
 * fake-success `null` that might be mistaken for "branch doesn't exist".
 */

import type {
  AdapterResult,
  ResolveBranchShaArgs,
  ResolveBranchShaResponse,
} from './types.js';

export async function resolveBranchShaGitlab(
  _args: ResolveBranchShaArgs,
): Promise<AdapterResult<ResolveBranchShaResponse | null>> {
  return {
    platform_unsupported: true,
    hint:
      'branch→SHA not needed — GitLab CI pipelines attach to branch names directly',
  };
}
