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
import type {
  AdapterResult,
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
    `gh pr view ${number} --json statusCheckRollup,url,state,isDraft,mergeable,mergeStateStatus${repoFlag(repo)}`,
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

export async function prWaitCiGithub(
  args: PrWaitCiArgs,
): Promise<AdapterResult<PrWaitCiResponse>> {
  // Bound any exception that escapes the snapshot helper into a typed result —
  // adapter callers must not have to try/catch.
  try {
    // #416 short-circuit. One probe BEFORE entering the polling loop: if the
    // PR's rollup is empty there is nothing to settle and we return at t=0.
    const probeStart = Date.now();
    const probe = probeGithub(args.number, args.repo);
    const rollup = probe.statusCheckRollup ?? [];
    if (rollup.length === 0) {
      const blocker = emptyRollupBlocker(probe);
      const elapsedSec = Math.max(0, Math.floor((Date.now() - probeStart) / 1000));
      const data: PrWaitCiNoChecksResponse = {
        number: args.number,
        status: 'no_checks_required',
        elapsed_sec: elapsedSec,
        mergeable: blocker === null,
        url: probe.url ?? '',
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
