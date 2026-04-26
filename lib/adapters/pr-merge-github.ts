/**
 * GitHub `pr_merge` adapter implementation.
 *
 * Lifted from `handlers/pr_merge.ts` per Story 1.10 (#247). The handler is now
 * a thin dispatcher; this module owns the GitHub-specific subprocess work and
 * normalizes the response into `AdapterResult<PrMergeResponse>`.
 *
 * Preserves the #225 aggregate envelope shape — `{enrolled, merged,
 * merge_method, queue, pr_state, url, merge_commit_sha?, warnings}` — and the
 * #263 fix for honest merged-state reporting (read actual state via
 * `fetchGithubPrState` after gh exit-0 instead of trusting that gh==merged).
 *
 * The merge-queue detect helper (`detectMergeQueue`) and PR state fetcher
 * (`fetchGithubPrState`) stay where they are per Dev Spec §5.3 — this adapter
 * imports from them, it does NOT re-lift them.
 */

import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import { detectMergeQueue, type MergeQueueInfo } from '../merge_queue_detect.js';
import { fetchGithubPrState } from '../pr_state.js';
import { parseRepoSlug } from '../shared/parse-repo-slug.js';
import type {
  AdapterResult,
  PrMergeArgs,
  PrMergeResponse,
  PrMergeQueueState,
  PrMergeMethod,
} from './types.js';

interface ExecError extends Error {
  stdout?: Buffer | string;
  stderr?: Buffer | string;
  status?: number;
}

interface FailureInfo {
  message: string;
  stderr: string;
}

function bufToString(b: unknown): string {
  if (b === undefined || b === null) return '';
  if (typeof b === 'string') return b;
  if (typeof (b as Buffer).toString === 'function') return (b as Buffer).toString();
  return String(b);
}

function extractFailure(err: unknown): FailureInfo {
  if (err instanceof Error) {
    const e = err as ExecError;
    const stderr = bufToString(e.stderr);
    const stdout = bufToString(e.stdout);
    const message = stderr.trim() || stdout.trim() || err.message;
    return { message, stderr: stderr || err.message };
  }
  const text = String(err);
  return { message: text, stderr: text };
}

// Heuristic for detecting GitHub merge-queue enforcement from stderr. Phrasings
// seen in the wild: "merge strategy for main is set by the merge queue", "the
// merge queue is required", "changes must be made through a merge queue". Match
// case-insensitive on "merge queue" to tolerate phrasing drift. Used as a
// safety net when up-front GraphQL detection returns a false-negative.
function stderrIndicatesMergeQueue(text: string): boolean {
  return /merge\s*queue/i.test(text);
}

function exec(cmd: string): string {
  return execSync(cmd, { encoding: 'utf8' });
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// `writeFileSync` is filesystem work, not subprocess work — so it stays in the
// adapter (alongside the rest of the GitHub-specific merge logic).
function writeTempMessageFile(message: string): string {
  const path = `/tmp/pr-merge-msg-${Date.now()}-${Math.floor(Math.random() * 1e6)}.txt`;
  writeFileSync(path, message);
  return path;
}

function buildGithubMergeCommand(
  number: number,
  auto: boolean,
  squashMessage?: string,
  repo?: string,
): string {
  const parts = ['gh', 'pr', 'merge', String(number), '--squash', '--delete-branch'];
  if (auto) parts.push('--auto');
  if (squashMessage !== undefined && squashMessage.length > 0) {
    if (squashMessage.includes('\n')) {
      const tempFile = writeTempMessageFile(squashMessage);
      parts.push('--body-file', shellEscape(tempFile));
    } else {
      parts.push('--body', shellEscape(squashMessage));
    }
  }
  if (repo !== undefined) {
    parts.push('--repo', repo);
  }
  return parts.join(' ');
}

// Resolve the repo slug for queue detection. Prefer the explicit input; fall
// back to the cwd remote; null if neither yields a usable slug. When null,
// queue detection is skipped (treated as no queue) and the legacy stderr
// fallback remains the only path into the queue.
function resolveRepoSlug(args: PrMergeArgs): string | null {
  if (args.repo !== undefined) return args.repo;
  return parseRepoSlug();
}

function emptyQueue(): PrMergeQueueState {
  return { enabled: false, position: null, enforced: false };
}

function queueFromInfo(info: MergeQueueInfo): PrMergeQueueState {
  return {
    enabled: info.enabled,
    enforced: info.enforced,
    // queue.position is reserved for future enrichment via the mergeQueue.entries
    // GraphQL field. Today we leave it null (a documented valid value per #225)
    // because the position is racy and would require a follow-up query for every
    // merge; the cost isn't justified by current callers.
    position: null,
  };
}

function aggregateOk(args: {
  number: number;
  enrolled: boolean;
  merged: boolean;
  method: PrMergeMethod;
  queue: PrMergeQueueState;
  url: string;
  mergeCommitSha?: string;
  warnings: string[];
}): PrMergeResponse {
  return {
    number: args.number,
    enrolled: args.enrolled,
    merged: args.merged,
    merge_method: args.method,
    queue: args.queue,
    pr_state: args.merged ? 'MERGED' : 'OPEN',
    url: args.url,
    merge_commit_sha: args.mergeCommitSha,
    warnings: args.warnings,
  };
}

// Decide the merge intent given user input + detected queue state. Returns
// the effective method and any warnings to surface. Pre-detection of an
// enforced queue lets us skip the legacy "try-direct-then-fallback-on-stderr"
// dance — saving a guaranteed-to-fail exec — while folding in #224's
// skip_train graceful-degrade behavior.
function decideIntent(
  args: PrMergeArgs,
  mq: MergeQueueInfo,
): { useQueue: boolean; warnings: string[] } {
  const warnings: string[] = [];
  if (args.use_merge_queue === true) {
    if (args.skip_train === true) {
      // The two flags are mutually contradictory. use_merge_queue is the
      // explicit caller intent, so it wins, but skip_train must not be
      // silently dropped per the #224/#225 contract.
      warnings.push(
        'skip_train ignored — use_merge_queue:true takes precedence; merge proceeded via merge_queue strategy',
      );
    }
    return { useQueue: true, warnings };
  }
  if (mq.enforced && args.skip_train === true) {
    warnings.push(
      'skip_train ignored — merge queue enforced; merge proceeded via merge_queue strategy',
    );
    return { useQueue: true, warnings };
  }
  if (mq.enforced) {
    return { useQueue: true, warnings };
  }
  return { useQueue: false, warnings };
}

function mergeGithubViaQueue(
  args: PrMergeArgs,
  queue: PrMergeQueueState,
  warnings: string[],
): AdapterResult<PrMergeResponse> {
  const cmd = buildGithubMergeCommand(args.number, true, args.squash_message, args.repo);
  try {
    exec(cmd);
  } catch (err) {
    return {
      ok: false,
      code: 'gh_pr_merge_auto_failed',
      error: `gh pr merge --auto failed: ${extractFailure(err).message}`,
    };
  }
  // Queue enrollment is eager: gh returns immediately, the PR remains OPEN
  // until the queue rebases + reruns CI + lands. Honest reporting per #225:
  // enrolled but not yet merged.
  const info = fetchGithubPrState(args.number, args.repo);
  return {
    ok: true,
    data: aggregateOk({
      number: args.number,
      enrolled: true,
      merged: info.state === 'merged',
      method: 'merge_queue',
      queue,
      url: info.url,
      mergeCommitSha: info.mergeCommitSha,
      warnings,
    }),
  };
}

function mergeGithubDirect(
  args: PrMergeArgs,
  queue: PrMergeQueueState,
  warnings: string[],
): AdapterResult<PrMergeResponse> {
  const directCmd = buildGithubMergeCommand(
    args.number,
    false,
    args.squash_message,
    args.repo,
  );
  try {
    exec(directCmd);
    // gh exit 0 doesn't mean "merged" — when a merge queue or auto-merge is
    // configured at the repo/branch level, gh may have enrolled the PR rather
    // than merged it synchronously. Read the actual state and report honestly
    // so callers (especially pr_merge_wait) don't trust a stale "merged:true".
    // See #258 for the regression history.
    const info = fetchGithubPrState(args.number, args.repo);
    const actuallyMerged = info.state === 'merged';
    return {
      ok: true,
      data: aggregateOk({
        number: args.number,
        enrolled: true,
        merged: actuallyMerged,
        method: actuallyMerged ? 'direct_squash' : 'merge_queue',
        queue,
        url: info.url,
        mergeCommitSha: info.mergeCommitSha,
        warnings,
      }),
    };
  } catch (err) {
    const fail = extractFailure(err);
    if (args.skip_train === true) {
      return {
        ok: false,
        code: 'gh_pr_merge_skip_train_failed',
        error: `gh pr merge failed (skip_train): ${fail.message}`,
      };
    }
    if (
      !stderrIndicatesMergeQueue(fail.stderr) &&
      !stderrIndicatesMergeQueue(fail.message)
    ) {
      return {
        ok: false,
        code: 'gh_pr_merge_failed',
        error: `gh pr merge failed: ${fail.message}`,
      };
    }
  }

  // Stderr-fallback path: detection thought no queue, but the API rejected
  // the direct merge with a queue-related error. Promote the queue state so
  // the response reflects what we just learned.
  const fallbackQueue: PrMergeQueueState = { enabled: true, position: null, enforced: true };
  const autoCmd = buildGithubMergeCommand(args.number, true, args.squash_message, args.repo);
  try {
    exec(autoCmd);
  } catch (err) {
    return {
      ok: false,
      code: 'gh_pr_merge_auto_fallback_failed',
      error: `gh pr merge --auto failed after merge-queue fallback: ${extractFailure(err).message}`,
    };
  }
  const info = fetchGithubPrState(args.number, args.repo);
  return {
    ok: true,
    data: aggregateOk({
      number: args.number,
      enrolled: true,
      merged: info.state === 'merged',
      method: 'merge_queue',
      queue: fallbackQueue,
      url: info.url,
      mergeCommitSha: info.mergeCommitSha,
      warnings,
    }),
  };
}

export async function prMergeGithub(
  args: PrMergeArgs,
): Promise<AdapterResult<PrMergeResponse>> {
  // Bound any exception that escapes the helpers below into a typed result —
  // adapter callers must not have to try/catch.
  try {
    const slug = resolveRepoSlug(args);
    const mqInfo = slug !== null ? detectMergeQueue(slug) : { enabled: false, enforced: false };
    const queue = queueFromInfo(mqInfo);
    const intent = decideIntent(args, mqInfo);

    return intent.useQueue
      ? mergeGithubViaQueue(args, queue, intent.warnings)
      : mergeGithubDirect(args, queue, intent.warnings);
  } catch (err) {
    return {
      ok: false,
      code: 'unexpected_error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// `execSync` is intentionally re-imported above so that adapter-level test
// files can `mock.module('child_process', ...)` and intercept this module's
// subprocess calls without needing access to the handler's mock setup.
void execSync;
