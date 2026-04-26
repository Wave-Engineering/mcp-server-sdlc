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

export async function prWaitCiGithub(
  args: PrWaitCiArgs,
): Promise<AdapterResult<PrWaitCiResponse>> {
  // Bound any exception that escapes the snapshot helper into a typed result —
  // adapter callers must not have to try/catch.
  try {
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
