// Origin Operations family handler.
// See docs/handlers/origin-operations-guide.md for the canonical pattern,
// gh ↔ glab field mappings, and normalized response schemas.

import { execSync } from 'child_process';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { detectPlatform, gitlabApiMr } from '../lib/glab';
import { log } from '../logger.js';

const inputSchema = z
  .object({
    number: z.number().int().positive(),
    poll_interval_sec: z.number().int().optional().default(30),
    timeout_sec: z.number().int().positive().optional().default(1800),
    repo: z
      .string()
      .regex(/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/, 'repo must be owner/repo format')
      .optional(),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export type CheckBucket = 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel';

export interface ChecksSnapshot {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  summary: string;
  url: string;
}

type FinalState = 'passed' | 'failed' | 'timed_out';

const POLL_FLOOR_SEC = 5;

function exec(cmd: string): string {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

// One item from `gh pr view --json statusCheckRollup`. Comes in two flavors:
//   __typename: "CheckRun"      — modern checks (GitHub Actions, most third-party)
//   __typename: "StatusContext" — legacy commit statuses from older integrations
// We treat both, defaulting unknown __typename values to "pending" so an
// unfamiliar shape can never make the loop decide prematurely.
interface RollupItem {
  __typename?: string;
  name?: string;
  // CheckRun fields
  status?: string;       // QUEUED | IN_PROGRESS | COMPLETED | WAITING | PENDING | REQUESTED
  conclusion?: string;   // SUCCESS | FAILURE | NEUTRAL | CANCELLED | SKIPPED | TIMED_OUT | ACTION_REQUIRED | STALE | STARTUP_FAILURE | ''
  // StatusContext fields
  state?: string;        // SUCCESS | FAILURE | ERROR | PENDING
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

function repoFlag(repo: string | undefined): string {
  return repo !== undefined ? ` --repo ${repo}` : '';
}

function parseSlugOpts(slug: string | undefined): { owner?: string; repo?: string } | undefined {
  if (slug === undefined) return undefined;
  const idx = slug.indexOf('/');
  if (idx <= 0 || idx === slug.length - 1) return undefined;
  return { owner: slug.slice(0, idx), repo: slug.slice(idx + 1) };
}

// `gh pr view --json statusCheckRollup,url` has shipped in gh for years and
// works on all currently-supported Ubuntu LTS images. The previous impl used
// `gh pr checks --json` which was added in a much later gh release and broke
// pr_wait_ci on gh 2.45 (Ubuntu 24.04 default) — see #220.
function snapshotGithub(number: number, repo?: string): ChecksSnapshot {
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

interface GitlabPipeline {
  status?: string;
}

interface GitlabMr {
  web_url?: string;
  head_pipeline?: GitlabPipeline;
  pipeline?: GitlabPipeline;
}

function snapshotGitlab(number: number, repo?: string): ChecksSnapshot {
  const mr = gitlabApiMr(number, parseSlugOpts(repo));
  const status = (
    mr.head_pipeline?.status ??
    mr.pipeline?.status ??
    'unknown'
  ).toLowerCase();
  const url = mr.web_url ?? '';

  // GitLab reports a single pipeline status; treat it as a single aggregated
  // "check" for accounting purposes so the counts schema stays consistent.
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

function snapshotChecks(number: number, repo?: string): ChecksSnapshot {
  const platform = detectPlatform();
  return platform === 'gitlab' ? snapshotGitlab(number, repo) : snapshotGithub(number, repo);
}

function decide(snap: ChecksSnapshot): FinalState | null {
  if (snap.failed > 0) return 'failed';
  if (snap.total > 0 && snap.pending === 0 && snap.passed >= 1) return 'passed';
  return null;
}

function logCycle(number: number, elapsedSec: number, snap: ChecksSnapshot) {
  log.debug('poll', {
    tool: 'pr_wait_ci',
    number,
    elapsed_sec: elapsedSec,
    pending: snap.pending,
    total: snap.total,
    summary: snap.summary,
  });
}

// Injection seam for tests — swap sleep + snapshot without touching real time/net.
interface Deps {
  snapshotFn: (number: number, repo?: string) => ChecksSnapshot;
  sleepFn: (ms: number) => Promise<void>;
  nowFn: () => number;
  /** Optional heartbeat called on each poll iteration for wave-status updates. */
  heartbeatFn?: (number: number, attempt: number, snap: ChecksSnapshot) => void;
}

function defaultHeartbeat(number: number, attempt: number, snap: ChecksSnapshot): void {
  const detail = `PR #${number} attempt ${attempt}: ${snap.summary}`;
  try {
    execSync(`wave-status waiting-ci '${detail.replace(/'/g, "'\\''")}'`, {
      encoding: 'utf8',
      timeout: 5000,
    });
  } catch {
    // Best-effort — swallow all errors silently.
  }
}

const defaultDeps: Deps = {
  snapshotFn: snapshotChecks,
  sleepFn: (ms: number) => new Promise((r) => setTimeout(r, ms)),
  nowFn: () => Date.now(),
  heartbeatFn: defaultHeartbeat,
};

export async function runPollLoop(
  args: Input,
  deps: Deps = defaultDeps,
): Promise<{
  ok: true;
  number: number;
  final_state: FinalState;
  checks: { total: number; passed: number; failed: number; pending: number; summary: string };
  waited_sec: number;
  url: string;
}> {
  const intervalMs = args.poll_interval_sec * 1000;
  const timeoutMs = args.timeout_sec * 1000;
  const start = deps.nowFn();

  let lastSnap: ChecksSnapshot = {
    total: 0,
    passed: 0,
    failed: 0,
    pending: 0,
    summary: 'no checks observed',
    url: '',
  };

  let attempt = 0;

  // Loop: snapshot → decide → (sleep | return). Timeout is checked after each
  // snapshot AND before each sleep so we can't over-shoot by a full interval.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt++;
    lastSnap = deps.snapshotFn(args.number, args.repo);
    const elapsedSec = Math.floor((deps.nowFn() - start) / 1000);
    logCycle(args.number, elapsedSec, lastSnap);
    deps.heartbeatFn?.(args.number, attempt, lastSnap);

    const decision = decide(lastSnap);
    if (decision) {
      return {
        ok: true,
        number: args.number,
        final_state: decision,
        checks: {
          total: lastSnap.total,
          passed: lastSnap.passed,
          failed: lastSnap.failed,
          pending: lastSnap.pending,
          summary: lastSnap.summary,
        },
        waited_sec: elapsedSec,
        url: lastSnap.url,
      };
    }

    if (deps.nowFn() - start >= timeoutMs) {
      return {
        ok: true,
        number: args.number,
        final_state: 'timed_out',
        checks: {
          total: lastSnap.total,
          passed: lastSnap.passed,
          failed: lastSnap.failed,
          pending: lastSnap.pending,
          summary: lastSnap.summary,
        },
        waited_sec: Math.floor((deps.nowFn() - start) / 1000),
        url: lastSnap.url,
      };
    }

    await deps.sleepFn(intervalMs);

    // Re-check timeout after sleep in case we slept past the deadline.
    if (deps.nowFn() - start >= timeoutMs) {
      lastSnap = deps.snapshotFn(args.number, args.repo);
      const finalElapsed = Math.floor((deps.nowFn() - start) / 1000);
      logCycle(args.number, finalElapsed, lastSnap);
      const postDecision = decide(lastSnap);
      return {
        ok: true,
        number: args.number,
        final_state: postDecision ?? 'timed_out',
        checks: {
          total: lastSnap.total,
          passed: lastSnap.passed,
          failed: lastSnap.failed,
          pending: lastSnap.pending,
          summary: lastSnap.summary,
        },
        waited_sec: finalElapsed,
        url: lastSnap.url,
      };
    }
  }
}

// Exposed for tests that want to drive the loop with injected deps.
export async function __runWithDeps(rawArgs: unknown, deps: Deps) {
  const args = inputSchema.parse(rawArgs) as Input;
  if (args.poll_interval_sec < POLL_FLOOR_SEC) {
    throw new Error(
      `poll_interval_sec must be >= ${POLL_FLOOR_SEC} (got ${args.poll_interval_sec})`,
    );
  }
  return runPollLoop(args, deps);
}

const prWaitCiHandler: HandlerDef = {
  name: 'pr_wait_ci',
  description:
    "Block until a PR/MR's check runs complete. Server-side polling with configurable interval (default 30s, min 5s) and timeout (default 1800s). Returns passed | failed | timed_out.",
  inputSchema,
  async execute(rawArgs: unknown) {
    let args: Input;
    try {
      args = inputSchema.parse(rawArgs) as Input;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error }) }],
      };
    }

    if (args.poll_interval_sec < POLL_FLOOR_SEC) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: `poll_interval_sec must be >= ${POLL_FLOOR_SEC} (got ${args.poll_interval_sec})`,
            }),
          },
        ],
      };
    }

    try {
      const result = await runPollLoop(args);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error }) }],
      };
    }
  },
};

export default prWaitCiHandler;
