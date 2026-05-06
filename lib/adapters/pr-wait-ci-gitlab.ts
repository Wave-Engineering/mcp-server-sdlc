/**
 * GitLab `pr_wait_ci` adapter implementation.
 *
 * Lifted from `handlers/pr_wait_ci.ts` per Story 1.9 (#246). Mirrors
 * `pr-wait-ci-github.ts` — the handler dispatches to either depending on cwd
 * platform.
 *
 * GitLab divergences from the GitHub flow:
 * - One MR fetch per poll iteration via `gitlabApiMr` (REST API
 *   `GET /projects/:id/merge_requests/:iid` — no `glab pipeline view`
 *   equivalent that returns the shape we need).
 * - GitLab reports a single pipeline status (`success`/`failed`/`running`/...);
 *   we treat it as a single aggregated "check" so the counts schema stays
 *   consistent with GitHub's per-check rollup.
 *
 * The polling loop itself lives in `lib/pr-wait-ci-poll.ts` and is shared
 * with the GitHub adapter — the AC explicitly forbids per-platform
 * duplication of timeout/decide/heartbeat/sleep logic.
 */

import { execSync } from 'child_process';
import { gitlabApiMr } from '../gitlab-api.js';
import {
  defaultDeps,
  runPollLoop,
  type ChecksSnapshot,
  type PollArgs,
} from '../pr-wait-ci-poll.js';
import type {
  AdapterResult,
  PrWaitCiArgs,
  PrWaitCiNoChecksResponse,
  PrWaitCiResponse,
} from './types.js';

function parseSlugOpts(slug: string | undefined): { owner?: string; repo?: string } | undefined {
  if (slug === undefined) return undefined;
  const idx = slug.indexOf('/');
  if (idx <= 0 || idx === slug.length - 1) return undefined;
  return { owner: slug.slice(0, idx), repo: slug.slice(idx + 1) };
}

/**
 * One snapshot of GitLab MR pipeline state via the GitLab REST API.
 *
 * GitLab reports a single pipeline status — translate it into our
 * `ChecksSnapshot` shape (one aggregated "check") so the polling loop can
 * apply the same decide-rule against either platform.
 *
 * Status mapping (preserved from the pre-migration handler):
 * - `success`                                  → pass (1)
 * - `failed` / `canceled` / `cancelled`        → fail (1)
 * - `running` / `pending` / `created` /
 *   `preparing` / `waiting_for_resource` /
 *   `scheduled` / `manual`                     → pending (1)
 * - anything else (incl. `unknown`)            → uncounted (total = 0)
 *
 * The `unknown` fall-through means an MR with no pipeline at all reports
 * `{total: 0, passed: 0, failed: 0, pending: 0}` — `decide()` will return
 * `null` (no decision possible) and the loop will eventually time out.
 * That matches the pre-migration behavior.
 */
export function snapshotGitlab(number: number, repo?: string): ChecksSnapshot {
  const mr = gitlabApiMr(number, parseSlugOpts(repo));
  const status = (
    mr.head_pipeline?.status ??
    mr.pipeline?.status ??
    'unknown'
  ).toLowerCase();
  const url = mr.web_url ?? '';

  let passed = 0;
  let failed = 0;
  let pending = 0;
  if (status === 'success') passed = 1;
  else if (
    status === 'failed' ||
    status === 'canceled' ||
    status === 'cancelled'
  )
    failed = 1;
  else if (
    status === 'running' ||
    status === 'pending' ||
    status === 'created' ||
    status === 'preparing' ||
    status === 'waiting_for_resource' ||
    status === 'scheduled' ||
    status === 'manual'
  )
    pending = 1;

  return {
    total: passed + failed + pending,
    passed,
    failed,
    pending,
    summary: `pipeline ${status}`,
    url,
  };
}

/**
 * Resolve the empty-pipeline short-circuit blocker (#416). Mirrors the GitHub
 * adapter's `emptyRollupBlocker` but reads from a `GitlabMr` shape: an MR with
 * no pipeline AND no obstructions returns `null`. Anything else returns a
 * short string naming the obstruction — `draft`, `closed`, `merged`,
 * `locked`, `conflicts`, or `not_mergeable`.
 */
function emptyPipelineBlockerGitlab(
  mr: { state?: string; draft?: boolean; work_in_progress?: boolean; has_conflicts?: boolean; merge_status?: string; detailed_merge_status?: string },
): string | null {
  const state = (mr.state ?? '').toLowerCase();
  if (state === 'closed') return 'closed';
  if (state === 'merged') return 'merged';
  if (state === 'locked') return 'locked';
  if (mr.draft === true || mr.work_in_progress === true) return 'draft';
  if (mr.has_conflicts === true) return 'conflicts';
  // GitLab's `merge_status: 'cannot_be_merged'` (or the newer
  // `detailed_merge_status` non-`mergeable` value) is the catch-all for any
  // obstruction we haven't named explicitly above. `can_be_merged` /
  // `mergeable` is the only happy path.
  const ms = (mr.merge_status ?? '').toLowerCase();
  const dms = (mr.detailed_merge_status ?? '').toLowerCase();
  if (ms === 'cannot_be_merged') return 'not_mergeable';
  if (dms !== '' && dms !== 'mergeable' && dms !== 'unchecked' && dms !== 'checking') {
    return 'not_mergeable';
  }
  return null;
}

export async function prWaitCiGitlab(
  args: PrWaitCiArgs,
): Promise<AdapterResult<PrWaitCiResponse>> {
  try {
    // #416 short-circuit. One probe BEFORE entering the polling loop: if the
    // MR has no pipeline data at all (neither `head_pipeline` nor `pipeline`),
    // there is nothing to settle and we return at t=0.
    const probeStart = Date.now();
    const mr = gitlabApiMr(args.number, parseSlugOpts(args.repo));
    const hasPipeline =
      (mr.head_pipeline !== undefined && mr.head_pipeline !== null) ||
      (mr.pipeline !== undefined && mr.pipeline !== null);
    if (!hasPipeline) {
      const blocker = emptyPipelineBlockerGitlab(mr);
      const elapsedSec = Math.max(0, Math.floor((Date.now() - probeStart) / 1000));
      const data: PrWaitCiNoChecksResponse = {
        number: args.number,
        status: 'no_checks_required',
        elapsed_sec: elapsedSec,
        mergeable: blocker === null,
        url: mr.web_url ?? '',
        ...(blocker !== null ? { blocker } : {}),
      };
      return { ok: true, data };
    }

    const pollArgs: PollArgs = {
      number: args.number,
      poll_interval_sec: args.poll_interval_sec,
      timeout_sec: args.timeout_sec,
      repo: args.repo,
    };
    const result = await runPollLoop(pollArgs, defaultDeps(snapshotGitlab));
    const { ok: _ok, ...data } = result;
    void _ok;
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      code: 'unexpected_error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// See pr-wait-ci-github.ts for the rationale.
void execSync;
