// Origin Operations family handler.
// See docs/handlers/origin-operations-guide.md for the canonical pattern.
//
// pr_merge_wait wraps pr_merge with a "block until commit lands on main" guarantee.
// Use this when downstream work (`git pull main`, post-merge CI checks) needs the
// merge to be observable. For "I just need to enroll the PR; I'll keep working,"
// stick with pr_merge.

import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { detectPlatform } from '../lib/shared/detect-platform.js';
import { parseRepoSlug } from '../lib/shared/parse-repo-slug.js';
import { fetchPrState, type PrStateInfo } from '../lib/pr_state.js';
import { performMerge } from './pr_merge.js';

const inputSchema = z.object({
  number: z.number().int().positive('number must be a positive integer'),
  squash_message: z.string().optional(),
  use_merge_queue: z.boolean().optional(),
  skip_train: z.boolean().optional(),
  repo: z
    .string()
    .regex(/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/, 'repo must be owner/repo format')
    .optional(),
  timeout_sec: z
    .number()
    .int()
    .positive('timeout_sec must be a positive integer')
    .optional(),
});

type Input = z.infer<typeof inputSchema>;
type Platform = 'github' | 'gitlab';

const DEFAULT_TIMEOUT_SEC = 600;
const POLL_INTERVAL_MS = 10_000;

// Detect-and-skip synthesizes this aggregate when the PR is already MERGED
// before invocation. We don't know how it was merged historically (direct vs
// queue, this session vs earlier), so report the conservative defaults and
// surface the situation via a warning.
function synthesizeAlreadyMerged(num: number, info: PrStateInfo) {
  return {
    ok: true as const,
    number: num,
    enrolled: true,
    merged: true,
    merge_method: 'direct_squash' as const,
    queue: { enabled: false, position: null, enforced: false },
    pr_state: 'MERGED' as const,
    url: info.url,
    merge_commit_sha: info.mergeCommitSha,
    warnings: ['PR was already merged before invocation; pr_merge was not called'],
  };
}

export interface PollDeps {
  fetchState: () => PrStateInfo;
  intervalMs: number;
  timeoutMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface PollSuccess {
  ok: true;
  state: PrStateInfo;
  elapsedMs: number;
}

export interface PollTimeout {
  ok: false;
  reason: 'timeout';
  lastState: PrStateInfo;
  elapsedMs: number;
}

export interface PollFetchError {
  ok: false;
  reason: 'fetch_error';
  error: string;
  lastState: PrStateInfo | null;
  elapsedMs: number;
}

// Pure poller — no module-level globals, no platform knowledge. Loops:
// fetch → return on merged → check timeout → sleep. The sleep happens AFTER
// the timeout check, so if the budget is already spent we don't waste another
// interval before reporting it. Injectable now/sleep makes tests instant.
//
// fetchState exceptions are caught and reported as a `fetch_error` variant so
// the caller can preserve the "PR was already enrolled" context — distinct
// from a clean timeout. Without this distinction, a transient `gh` failure
// mid-poll would surface as a generic outer-catch error and the caller would
// have no idea whether the merge itself failed or just the polling did.
export async function pollUntilMerged(
  deps: PollDeps,
): Promise<PollSuccess | PollTimeout | PollFetchError> {
  const start = deps.now();
  let lastState: PrStateInfo | null = null;
  while (true) {
    let info: PrStateInfo;
    try {
      info = deps.fetchState();
    } catch (err) {
      return {
        ok: false,
        reason: 'fetch_error',
        error: err instanceof Error ? err.message : String(err),
        lastState,
        elapsedMs: deps.now() - start,
      };
    }
    lastState = info;
    const elapsedMs = deps.now() - start;
    if (info.state === 'merged') {
      return { ok: true, state: info, elapsedMs };
    }
    if (elapsedMs >= deps.timeoutMs) {
      return { ok: false, reason: 'timeout', lastState: info, elapsedMs };
    }
    await deps.sleep(deps.intervalMs);
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface MergeAggregate {
  ok: true;
  number: number;
  enrolled: boolean;
  merged: boolean;
  merge_method: 'direct_squash' | 'merge_queue';
  queue: { enabled: boolean; position: number | null; enforced: boolean };
  pr_state: 'OPEN' | 'MERGED';
  url: string;
  merge_commit_sha?: string;
  warnings: string[];
}

interface MergeFailure {
  ok: false;
  error: string;
}

function isFailure(r: MergeAggregate | MergeFailure): r is MergeFailure {
  return r.ok === false;
}

async function executeWait(
  args: Input,
  platform: Platform,
  pollOverrides?: Partial<Pick<PollDeps, 'now' | 'sleep' | 'intervalMs'>>,
): Promise<MergeAggregate | MergeFailure> {
  const slug = args.repo ?? parseRepoSlug() ?? undefined;
  const timeoutMs = (args.timeout_sec ?? DEFAULT_TIMEOUT_SEC) * 1000;

  // Detect-and-skip: if the PR is already MERGED, return immediately. Saves a
  // pointless `gh pr merge` call (which would error "already merged") and a
  // full polling cycle.
  let preState: PrStateInfo;
  try {
    preState = fetchPrState(platform, args.number, slug);
  } catch (err) {
    return {
      ok: false,
      error: `pr_merge_wait failed to read initial PR state: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
  if (preState.state === 'merged') {
    return synthesizeAlreadyMerged(args.number, preState);
  }

  const mergeResult = performMerge(platform, args) as MergeAggregate | MergeFailure;
  if (isFailure(mergeResult)) return mergeResult;
  if (mergeResult.merged) {
    // Direct path — already on main. No need to poll.
    return mergeResult;
  }

  // Queue path: enrolled but not yet on main. Poll until merged or timeout.
  const poll = await pollUntilMerged({
    fetchState: () => fetchPrState(platform, args.number, slug),
    intervalMs: pollOverrides?.intervalMs ?? POLL_INTERVAL_MS,
    timeoutMs,
    now: pollOverrides?.now ?? Date.now,
    sleep: pollOverrides?.sleep ?? defaultSleep,
  });

  if (!poll.ok) {
    if (poll.reason === 'fetch_error') {
      // Critical context: the PR was successfully enrolled — only the polling
      // loop failed. Caller can retry the wait without re-enrolling.
      const lastSnippet = poll.lastState
        ? `last_state: ${poll.lastState.state.toUpperCase()}`
        : 'no successful poll before failure';
      return {
        ok: false,
        error:
          `pr_merge_wait polling failed for PR #${args.number} after enrollment ` +
          `(${lastSnippet}, queue.enforced: ${mergeResult.queue.enforced}): ${poll.error}`,
      };
    }
    return {
      ok: false,
      error:
        `pr_merge_wait timed out after ${args.timeout_sec ?? DEFAULT_TIMEOUT_SEC}s ` +
        `waiting for PR #${args.number} to land on main ` +
        `(last_state: ${poll.lastState.state.toUpperCase()}, ` +
        `queue.enforced: ${mergeResult.queue.enforced})`,
    };
  }

  return {
    ...mergeResult,
    merged: true,
    pr_state: 'MERGED',
    url: poll.state.url || mergeResult.url,
    merge_commit_sha: poll.state.mergeCommitSha ?? mergeResult.merge_commit_sha,
  };
}

// Exposed for tests so they can inject fake clock + sleep without requiring
// real wall-clock time. Production callers go through the handler.
export async function executeWaitForTest(
  args: Input,
  platform: Platform,
  overrides: Partial<Pick<PollDeps, 'now' | 'sleep' | 'intervalMs'>>,
): Promise<MergeAggregate | MergeFailure> {
  return executeWait(args, platform, overrides);
}

const prMergeWaitHandler: HandlerDef = {
  name: 'pr_merge_wait',
  description:
    'Merge a PR/MR and BLOCK until the commit is observable on main (or timeout). ' +
    'Same input as pr_merge plus timeout_sec (default 600). Returns the same aggregate ' +
    'envelope as pr_merge with merged=true, pr_state="MERGED" guaranteed on success. ' +
    'Detects "already merged" and short-circuits without re-attempting the merge. ' +
    'Use this when downstream work needs the commit on main; use pr_merge when ' +
    'enrollment is enough.',
  inputSchema,
  async execute(rawArgs: unknown) {
    let args: Input;
    try {
      args = inputSchema.parse(rawArgs);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error }) }],
      };
    }

    try {
      const platform = detectPlatform();
      const result = await executeWait(args, platform);
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

export default prMergeWaitHandler;
