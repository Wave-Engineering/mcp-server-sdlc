/**
 * GitHub `pr_wait_ci` adapter implementation.
 *
 * Lifted from `handlers/pr_wait_ci.ts` per Story 1.9 (#246). The handler is
 * now a thin dispatcher; this module owns the GitHub-specific snapshot work
 * (one query per poll iteration) and feeds it to the platform-agnostic
 * `runPollLoop` from `lib/pr-wait-ci-poll.ts`.
 *
 * **Story 1.9 architecture note.** The polling loop itself is NOT lifted into
 * either adapter — duplicating the timeout/decide/heartbeat/sleep logic per
 * platform is exactly what the AC forbids. Both `pr-wait-ci-github.ts` and
 * `pr-wait-ci-gitlab.ts` wrap their own `snapshotFn` and call the shared
 * `runPollLoop`.
 *
 * **Preserved-verbatim regression (#220).** The argv shape stays
 * `gh pr view <num> --json statusCheckRollup,url` — NOT
 * `gh pr checks --json` (which was added in a later gh release and broke
 * pr_wait_ci on the gh 2.45 default for Ubuntu 24.04).
 */

import { execSync } from 'child_process';
import {
  defaultDeps,
  runPollLoop,
  type ChecksSnapshot,
  type Deps,
  type PollArgs,
  type PollResult,
} from '../pr-wait-ci-poll.js';
import { ciListRunsGithub } from './ci-list-runs-github.js';
import type {
  AdapterResult,
  CiListRunsArgs,
  PrWaitCiArgs,
  PrWaitCiNoChecksResponse,
  PrWaitCiResponse,
} from './types.js';

function exec(cmd: string): string {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

function repoFlag(repo: string | undefined): string {
  return repo !== undefined ? ` --repo ${repo}` : '';
}

// One item from `gh pr view --json statusCheckRollup`. Comes in two flavors:
//   __typename: "CheckRun"      — modern checks (GitHub Actions, most third-party)
//   __typename: "StatusContext" — legacy commit statuses from older integrations
// We treat both, defaulting unknown __typename values to "pending" so an
// unfamiliar shape can never make the loop decide prematurely.
export interface RollupItem {
  __typename?: string;
  name?: string;
  // CheckRun fields
  status?: string; // QUEUED | IN_PROGRESS | COMPLETED | WAITING | PENDING | REQUESTED
  conclusion?: string; // SUCCESS | FAILURE | NEUTRAL | CANCELLED | SKIPPED | TIMED_OUT | ACTION_REQUIRED | STALE | STARTUP_FAILURE | ''
  // StatusContext fields
  state?: string; // SUCCESS | FAILURE | ERROR | PENDING
}

interface PrViewResponse {
  url?: string;
  statusCheckRollup?: RollupItem[];
}

interface PrProbeResponse {
  url?: string;
  statusCheckRollup?: RollupItem[];
  state?: string; // OPEN | CLOSED | MERGED
  isDraft?: boolean;
  mergeable?: string | boolean; // MERGEABLE | CONFLICTING | UNKNOWN | bool
  mergeStateStatus?: string; // CLEAN | DIRTY | BLOCKED | UNSTABLE | UNKNOWN
  headRefOid?: string; // head SHA — anchors the #508 pending-run cross-check
}

type Bucket = 'pass' | 'fail' | 'pending' | 'skipping';

/**
 * Pure mapper from a single statusCheckRollup item to our bucket. Exported
 * for unit tests so the mapping table can be exercised without a subprocess.
 *
 * Decision rules:
 * - CheckRun NOT yet COMPLETED → pending (don't decide on incomplete check)
 * - CheckRun COMPLETED with SUCCESS / NEUTRAL → pass
 * - CheckRun COMPLETED with SKIPPED / STALE → skipping (uncounted, like before)
 * - CheckRun COMPLETED with anything else → fail. Includes:
 *     FAILURE, CANCELLED, TIMED_OUT, STARTUP_FAILURE — all genuine non-success
 *     outcomes; CANCELLED → fail preserves the prior `bucket === 'cancel'`
 *     mapping. Also includes ACTION_REQUIRED, which means a workflow paused
 *     for a human approval gate (e.g. environment protection rule). For an
 *     autopilot caller (/scpmmr, wave-machine), ACTION_REQUIRED is terminal
 *     in the same way as a hard failure — the merge cannot proceed without
 *     manual intervention. Mapping to "pending" would silently burn the
 *     timeout budget waiting for a human.
 * - StatusContext SUCCESS → pass
 * - StatusContext PENDING / unset → pending
 * - StatusContext FAILURE / ERROR → fail
 * - Unknown __typename → pending (defensive; never decide on what we can't classify)
 */
export function classifyRollupItem(c: RollupItem): Bucket {
  if (c.__typename === 'CheckRun') {
    const status = (c.status ?? '').toUpperCase();
    if (status !== 'COMPLETED') return 'pending';
    const conclusion = (c.conclusion ?? '').toUpperCase();
    if (conclusion === 'SUCCESS' || conclusion === 'NEUTRAL') return 'pass';
    if (conclusion === 'SKIPPED' || conclusion === 'STALE') return 'skipping';
    return 'fail';
  }
  if (c.__typename === 'StatusContext') {
    const state = (c.state ?? '').toUpperCase();
    if (state === 'SUCCESS') return 'pass';
    if (state === 'PENDING' || state === '') return 'pending';
    return 'fail';
  }
  return 'pending';
}

/**
 * One snapshot of GitHub PR check state via
 * `gh pr view <num> --json statusCheckRollup,url[ --repo <slug>]`.
 *
 * **#220 regression guard:** Do NOT switch to `gh pr checks --json` — that
 * subcommand wasn't added to gh until ~2.50 and breaks on the gh 2.45 that
 * ships with Ubuntu 24.04 LTS. The `gh pr view --json statusCheckRollup`
 * form has shipped for years.
 */
export function snapshotGithub(number: number, repo?: string): ChecksSnapshot {
  const raw = exec(`gh pr view ${number} --json statusCheckRollup,url${repoFlag(repo)}`);
  const view = JSON.parse(raw) as PrViewResponse;
  const checks = view.statusCheckRollup ?? [];

  let passed = 0;
  let failed = 0;
  let pending = 0;
  for (const c of checks) {
    const b = classifyRollupItem(c);
    if (b === 'pass') passed++;
    else if (b === 'fail') failed++;
    else if (b === 'pending') pending++;
    // 'skipping' is not counted against any bucket
  }

  const total = checks.length;
  return {
    total,
    passed,
    failed,
    pending,
    summary: `${passed}/${total} passed, ${failed} failed, ${pending} pending`,
    url: view.url ?? '',
  };
}

/**
 * Initial probe — single `gh pr view` that pulls rollup + mergeability fields
 * in one shot (#416). Used to detect the empty-rollup short-circuit case
 * before the polling loop even starts. Separate from `snapshotGithub` because
 * the polling loop's per-iteration query stays minimal (no need to repeat
 * mergeability on every poll).
 */
export function probeGithub(number: number, repo?: string): PrProbeResponse {
  const raw = exec(
    `gh pr view ${number} --json statusCheckRollup,url,state,isDraft,mergeable,mergeStateStatus,headRefOid${repoFlag(repo)}`,
  );
  return JSON.parse(raw) as PrProbeResponse;
}

/**
 * Resolve the empty-rollup short-circuit blocker (#416). Returns `null` when
 * the PR is mergeable today (no checks AND no obstructions). Otherwise returns
 * a short string naming the obstruction — `draft`, `closed`, `merged`,
 * `conflicts`, or `not_mergeable` — for inclusion in the typed response.
 *
 * `mergeable` is a tri-state on GitHub: `MERGEABLE | CONFLICTING | UNKNOWN`
 * (or boolean on older REST shapes). We treat anything that isn't an explicit
 * "yes, mergeable" as a blocker so callers never get a false-positive on a PR
 * that GitHub is still computing.
 */
export function emptyRollupBlocker(probe: PrProbeResponse): string | null {
  const state = (probe.state ?? '').toUpperCase();
  if (state === 'CLOSED') return 'closed';
  if (state === 'MERGED') return 'merged';
  if (probe.isDraft === true) return 'draft';

  const mergeableRaw =
    typeof probe.mergeable === 'string' ? probe.mergeable.toUpperCase() : probe.mergeable;
  const mergeable = mergeableRaw === true || mergeableRaw === 'MERGEABLE';
  if (!mergeable) {
    const mergeState = (probe.mergeStateStatus ?? '').toUpperCase();
    if (mergeState === 'DIRTY' || mergeableRaw === 'CONFLICTING') return 'conflicts';
    return 'not_mergeable';
  }
  return null;
}

/**
 * How long to keep re-probing an empty rollup before concluding the repo has no
 * checks for this ref (#508). A `pull_request`-triggered workflow registers
 * within seconds of PR creation; the window only has to outlast that gap.
 *
 * It is NOT a CI timeout — once a single check registers we fall through to the
 * normal polling loop and `timeout_sec` governs from there.
 */
export const SETTLE_WINDOW_SEC = 45;
export const SETTLE_POLL_SEC = 5;

/** Injectable seams so the settle loop is testable without real time or a real gh. */
export interface SettleDeps {
  probe: (number: number, repo?: string) => PrProbeResponse;
  /**
   * Runs for the head SHA — evidence that checks are coming but unregistered.
   *
   * Discriminated on purpose. A query that FAILS is not a query that found
   * nothing, and collapsing the two would let a broken `gh` report
   * "no CI configured" — an instrument that examined nothing, reporting the
   * one answer a caller might merge on. `{ok:false}` is carried through to
   * `evidence_unavailable`.
   */
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

/**
 * A run counts as evidence only while it is NOT finished. A completed run for
 * this SHA that never produced a check is not "CI is coming" — it is CI that
 * already came and went (a skipped workflow, a path-filtered job), and treating
 * it as pending would hold every such PR for the full window and then report
 * `no_checks_yet` forever.
 */
export function isUnfinished(status: string): boolean {
  const s = status.toLowerCase();
  return s !== 'completed' && s !== 'cancelled' && s !== 'skipped';
}

export function defaultSettleDeps(overrides: Partial<SettleDeps> = {}): SettleDeps {
  return {
    probe: probeGithub,
    pendingRuns: async (headSha, repo) => {
      const args: CiListRunsArgs = { ref: headSha, limit: 20, ...(repo !== undefined ? { repo } : {}) };
      try {
        const res = await ciListRunsGithub(args);
        if (!('ok' in res) || !res.ok || !Array.isArray(res.data)) return { ok: false };
        return {
          ok: true,
          runs: res.data
            .filter((r) => r.head_sha === headSha && isUnfinished(r.status))
            .map((r) => ({ run_id: r.run_id, workflow_name: r.workflow_name, status: r.status })),
        };
      } catch {
        return { ok: false };
      }
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    settleWindowSec: SETTLE_WINDOW_SEC,
    settlePollSec: SETTLE_POLL_SEC,
    ...overrides,
  };
}

export async function prWaitCiGithub(
  args: PrWaitCiArgs,
  depsIn: Partial<SettleDeps> = {},
): Promise<AdapterResult<PrWaitCiResponse>> {
  // Bound any exception that escapes the snapshot helper into a typed result —
  // adapter callers must not have to try/catch.
  try {
    // #508. #416 short-circuited here at t=0: one probe, and an empty rollup
    // returned `no_checks_required` immediately. An empty rollup is ALSO what a
    // merely-QUEUED check looks like, so a PR whose CI had not started yet
    // reported a definite, successful-sounding verdict with `elapsed_sec: 0`.
    //
    // Observed on cc-workflow#1087: `pr_wait_ci` said no_checks_required while
    // `gh pr checks` said `validate pending` seconds later. The live cost was a
    // spurious HALT, not a bad merge — `/mmr` allowlists on `passed` — but the
    // ambiguity lived in the API contract, so every future caller inherited it.
    //
    // So: keep probing until a check registers or the settle window elapses.
    const deps = defaultSettleDeps({
      ...(args.settle_window_sec !== undefined
        ? { settleWindowSec: args.settle_window_sec }
        : {}),
      ...depsIn, // explicit injection still wins, so tests stay in control
    });
    const probeStart = deps.now();
    let probe = deps.probe(args.number, args.repo);
    let rollup = probe.statusCheckRollup ?? [];

    if (rollup.length === 0) {
      // A hard blocker makes waiting pointless: a closed, merged or draft PR is
      // not going to start CI, and holding the caller for the window buys
      // nothing. Returning at once here is the ONE place a zero settle is right.
      const blocker = emptyRollupBlocker(probe);
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
            url: probe.url ?? '',
          },
        };
      }

      const deadline = probeStart + deps.settleWindowSec * 1000;
      while (rollup.length === 0 && deps.now() < deadline) {
        await deps.sleep(deps.settlePollSec * 1000);
        probe = deps.probe(args.number, args.repo);
        rollup = probe.statusCheckRollup ?? [];
      }

      if (rollup.length === 0) {
        // Still nothing. Cross-check the REF before calling it "no CI here":
        // a queued run for the head SHA is positive evidence that checks are
        // coming, and reporting that as "no checks configured" is the same
        // false-certainty this issue is about, just later on the clock.
        // No head SHA means no anchor for the query. Claiming either answer off
        // an unanchored search would be false certainty pointed one way or the
        // other, so treat it as "cannot certify" rather than "no CI here".
        const headSha = probe.headRefOid ?? '';
        const evidence = headSha === ''
          ? ({ ok: false } as const)
          : await deps.pendingRuns(headSha, args.repo);
        const settledSec = Math.max(0, Math.floor((deps.now() - probeStart) / 1000));

        // Only ONE branch may claim "this repo runs no checks": a query that
        // SUCCEEDED and found nothing. Everything else — the query failed, no
        // SHA to anchor it, or runs found — is `no_checks_yet` and not mergeable.
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
          // `no_checks_yet` is NEVER mergeable: either CI exists and has not
          // reported, or we could not establish that it doesn't.
          mergeable: certified,
          url: probe.url ?? '',
          ...(blocker !== undefined ? { blocker } : {}),
          ...(runs.length > 0 ? { pending_runs: runs } : {}),
        };
        return { ok: true, data };
      }
      // Checks registered during the window — fall through to the poll loop,
      // which is the whole point: this PR now gets a real passed/failed verdict.
    }

    const pollArgs: PollArgs = {
      number: args.number,
      poll_interval_sec: args.poll_interval_sec,
      timeout_sec: args.timeout_sec,
      repo: args.repo,
    };
    const result = await runPollLoop(pollArgs, defaultDeps(snapshotGithub));
    // Strip the `ok: true` discriminator — it lives at the AdapterResult layer,
    // not the inner data payload.
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

// Re-exports — `runPollLoop` + `defaultDeps` are convenience exports for the
// handler's `__runWithDeps` test seam (which composes them with caller-injected
// stubs). The poll-loop module remains the canonical location.
export { runPollLoop, defaultDeps };
export type { ChecksSnapshot, Deps, PollResult };
