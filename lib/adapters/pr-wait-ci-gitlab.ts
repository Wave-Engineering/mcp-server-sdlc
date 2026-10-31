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
import { gitlabApiMr, gitlabRepoOpts, type GitlabMr } from '../gitlab-api.js';
import {
  apiParentsOf,
  bindHeadPipeline,
  headFreshness,
  mrHeadSha,
  mrPipeline,
  type HeadFreshness,
  type ParentsOf,
} from '../gitlab-head-pipeline.js';
import { ciListRunsGitlab } from './ci-list-runs-gitlab.js';
import {
  defaultDeps,
  remainingWaitSec,
  runPollLoop,
  type ChecksSnapshot,
  type PollArgs,
} from '../pr-wait-ci-poll.js';
import type {
  AdapterResult,
  CiListRunsArgs,
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
 *
 * #588: a pipeline is graded only when it is bound to the MR's current head
 * (`bindHeadPipeline`). Right after a push `head_pipeline` can still be the
 * previous head's — already terminal — so an unbound pipeline reads as
 * pending, whatever its status, and the wait holds until the head's pipeline
 * is attached. A bound pipeline is named in `graded`. The MR record itself lags
 * a push, so its head must also match `freshness` (expected_sha, else the
 * source branch tip) before anything binds.
 */
export function snapshotGitlab(
  number: number,
  repo?: string,
  parentsOf: ParentsOf = apiParentsOf(gitlabRepoOpts(repo)),
  freshness: HeadFreshness = headFreshness(undefined, gitlabRepoOpts(repo)),
): ChecksSnapshot {
  const mr = gitlabApiMr(number, parseSlugOpts(repo));
  const url = mr.web_url ?? '';
  const pipeline = mrPipeline(mr);
  if (pipeline !== null) {
    const binding = bindHeadPipeline(mr, parentsOf, freshness);
    if (!binding.bound) {
      return { total: 1, passed: 0, failed: 0, pending: 1, summary: binding.reason, url };
    }
  }
  const status = (pipeline?.status ?? 'unknown').toLowerCase();

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
    ...(pipeline !== null
      ? { graded: { id: pipeline.id, sha: pipeline.sha, ref: pipeline.ref } }
      : {}),
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

/**
 * Settle knobs for the GitLab twin of the #508 fix. GitLab creates the pipeline
 * asynchronously after the MR, so `head_pipeline: null` has exactly the same
 * two meanings as GitHub's empty rollup — "no CI here" and "no CI *yet*".
 */
export const SETTLE_WINDOW_SEC_GITLAB = 45;
export const SETTLE_POLL_SEC_GITLAB = 5;

export interface SettleDepsGitlab {
  probe: (number: number, repo?: string) => GitlabMr;
  /** Discriminated: a FAILED query is not a query that found nothing (#508). */
  pendingRuns: (
    headSha: string,
    repo?: string,
  ) => Promise<
    | { ok: true; runs: { run_id: number; workflow_name: string; status: string }[] }
    | { ok: false }
  >;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  settleWindowSec: number;
  settlePollSec: number;
}

/** GitLab pipeline statuses that mean "still going to report". */
function isUnfinishedGitlab(status: string): boolean {
  const s = status.toLowerCase();
  return s === 'created' || s === 'waiting_for_resource' || s === 'preparing' ||
    s === 'pending' || s === 'running' || s === 'scheduled' || s === 'manual';
}

export function defaultSettleDepsGitlab(
  overrides: Partial<SettleDepsGitlab> = {},
): SettleDepsGitlab {
  return {
    probe: (n, repo) => gitlabApiMr(n, parseSlugOpts(repo)),
    pendingRuns: async (headSha, repo) => {
      const listArgs: CiListRunsArgs = {
        ref: headSha,
        limit: 20,
        ...(repo !== undefined ? { repo } : {}),
      };
      try {
        const res = await ciListRunsGitlab(listArgs);
        if (!('ok' in res) || !res.ok || !Array.isArray(res.data)) return { ok: false };
        return {
          ok: true,
          runs: res.data
            .filter((r) => r.head_sha === headSha && isUnfinishedGitlab(r.status))
            .map((r) => ({ run_id: r.run_id, workflow_name: r.workflow_name, status: r.status })),
        };
      } catch {
        return { ok: false };
      }
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    settleWindowSec: SETTLE_WINDOW_SEC_GITLAB,
    settlePollSec: SETTLE_POLL_SEC_GITLAB,
    ...overrides,
  };
}

export async function prWaitCiGitlab(
  args: PrWaitCiArgs,
  depsIn: Partial<SettleDepsGitlab> = {},
): Promise<AdapterResult<PrWaitCiResponse>> {
  try {
    // #508 — the GitLab half. #416 returned at t=0 when the MR carried no
    // pipeline data. GitLab creates the pipeline ASYNCHRONOUSLY after the MR, so
    // `head_pipeline: null` is also exactly what "the pipeline has not been
    // created yet" looks like. Same ambiguity as the GitHub empty rollup, same
    // fix: keep probing, then cross-check the ref before concluding.
    const deps = defaultSettleDepsGitlab({
      ...(args.settle_window_sec !== undefined
        ? { settleWindowSec: args.settle_window_sec }
        : {}),
      ...depsIn,
    });
    const probeStart = deps.now();
    let mr = deps.probe(args.number, args.repo);
    const hasPipelineNow = (m: GitlabMr): boolean =>
      (m.head_pipeline !== undefined && m.head_pipeline !== null) ||
      (m.pipeline !== undefined && m.pipeline !== null);
    if (!hasPipelineNow(mr)) {
      // A hard blocker makes waiting pointless — a closed/merged/draft MR is not
      // going to start a pipeline.
      const blocker = emptyPipelineBlockerGitlab(mr);
      if (blocker !== null) {
        return {
          ok: true,
          data: {
            number: args.number,
            status: 'no_checks_configured',
            elapsed_sec: Math.max(0, Math.floor((deps.now() - probeStart) / 1000)),
            settled_sec: 0,
            mergeable: false,
            blocker,
            url: mr.web_url ?? '',
          },
        };
      }

      const deadline = probeStart + deps.settleWindowSec * 1000;
      while (!hasPipelineNow(mr) && deps.now() < deadline) {
        await deps.sleep(deps.settlePollSec * 1000);
        mr = deps.probe(args.number, args.repo);
      }

      if (!hasPipelineNow(mr)) {
        const headSha = mrHeadSha(mr);
        const evidence = headSha === ''
          ? ({ ok: false } as const)
          : await deps.pendingRuns(headSha, args.repo);
        const settledSec = Math.max(0, Math.floor((deps.now() - probeStart) / 1000));
        // Only a query that SUCCEEDED and found nothing may claim "no CI here".
        const certified = evidence.ok && evidence.runs.length === 0;
        const runs = evidence.ok ? evidence.runs : [];
        const blocker = certified
          ? undefined
          : runs.length > 0
            ? 'checks_not_registered'
            : 'evidence_unavailable';
        const data: PrWaitCiNoChecksResponse = {
          number: args.number,
          status: certified ? 'no_checks_configured' : 'no_checks_yet',
          elapsed_sec: settledSec,
          settled_sec: settledSec,
          mergeable: certified,
          url: mr.web_url ?? '',
          ...(blocker !== undefined ? { blocker } : {}),
          ...(runs.length > 0 ? { pending_runs: runs } : {}),
        };
        return { ok: true, data };
      }
      // A pipeline appeared during the window — fall through to the poll loop.
    }

    // #587: the settle window spends the per-call budget and timeout alike.
    const spentMs = deps.now() - probeStart;
    const maxWaitSec = remainingWaitSec(args.max_wait_sec, spentMs);
    const pollArgs: PollArgs = {
      number: args.number,
      poll_interval_sec: args.poll_interval_sec,
      timeout_sec: remainingWaitSec(args.timeout_sec, spentMs),
      ...(maxWaitSec !== undefined ? { max_wait_sec: maxWaitSec } : {}),
      repo: args.repo,
    };
    // One memoised parents lookup for the whole wait (#588).
    const parentsOf = apiParentsOf(gitlabRepoOpts(args.repo));
    const freshness = headFreshness(args.expected_sha, gitlabRepoOpts(args.repo));
    const result = await runPollLoop(
      pollArgs,
      defaultDeps((n, repo) => snapshotGitlab(n, repo, parentsOf, freshness)),
    );
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
