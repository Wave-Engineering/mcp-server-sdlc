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

interface GithubCheck {
  name?: string;
  bucket?: string;
  state?: string;
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

function snapshotGithub(number: number, repo?: string): ChecksSnapshot {
  const raw = exec(`gh pr checks ${number} --json name,bucket,state${repoFlag(repo)}`);
  const checks = JSON.parse(raw) as GithubCheck[];

  let passed = 0;
  let failed = 0;
  let pending = 0;
  for (const c of checks) {
    const b = (c.bucket ?? '').toLowerCase();
    if (b === 'pass') passed++;
    else if (b === 'fail' || b === 'cancel') failed++;
    else if (b === 'pending') pending++;
    // 'skipping' is not counted against any bucket
  }

  const urlRaw = (() => {
    try {
      return exec(`gh pr view ${number} --json url${repoFlag(repo)}`);
    } catch {
      return '{"url":""}';
    }
  })();
  const url = (JSON.parse(urlRaw) as { url?: string }).url ?? '';

  const total = checks.length;
  return {
    total,
    passed,
    failed,
    pending,
    summary: `${passed}/${total} passed, ${failed} failed, ${pending} pending`,
    url,
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
