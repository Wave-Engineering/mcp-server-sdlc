/**
 * GitHub `pr_merge` adapter implementation.
 *
 * Lifted from `handlers/pr_merge.ts` per Story 1.10 (#247). The handler is now
 * a thin dispatcher; this module owns the GitHub-specific subprocess work and
 * normalizes the response into `AdapterResult<PrMergeResponse>`.
 *
 * Preserves the #225 aggregate envelope shape — `{enrolled, merged,
 * merge_method, queue, pr_state, url, merge_commit_sha?, warnings}` — and the
 * #263 fix for honest merged-state reporting (read actual state via the
 * `fetchPrState` adapter after gh exit-0 instead of trusting that gh==merged).
 *
 * Story 1.11 (#248) routes `PR state` lookups through
 * `getAdapter().fetchPrState(...)` — the FIRST hybrid sub-call dispatched
 * via the platform adapter — instead of importing `lib/pr_state.ts` directly.
 * The merge-queue detect helper (`detectMergeQueue`) stays as a `lib/` import
 * (still GitHub-only).
 */

import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import { detectMergeQueue, type MergeQueueInfo } from '../merge_queue_detect.js';
import { parseRepoSlug } from '../shared/parse-repo-slug.js';
import { getAdapter } from './index.js';
import type {
  AdapterResult,
  PrMergeArgs,
  PrMergeResponse,
  PrMergeQueueState,
  PrMergeMethod,
  PrStateInfo,
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

// GraphQL enqueuePullRequest mutation for repos with merge-queue enabled but
// enablePullRequestAutoMerge disabled. Returns the queue position or null if
// the position field is unavailable.
function enqueuePullRequestViaGraphQL(
  number: number,
  repo: string | undefined,
): number | null {
  // Step 1: fetch the PR's node_id. When repo is undefined, gh uses the
  // current directory's remote. When repo is provided, we must include it in
  // both the API path and --repo flag.
  let nodeIdCmd: string;
  if (repo !== undefined) {
    nodeIdCmd = `gh api repos/${repo}/pulls/${number} --repo ${repo} --jq '.node_id'`;
  } else {
    // When repo is undefined, resolve via the slug parser (same logic as
    // detectMergeQueue). If that fails, let gh api infer from cwd.
    const slug = parseRepoSlug();
    if (slug !== null) {
      nodeIdCmd = `gh api repos/${slug}/pulls/${number} --jq '.node_id'`;
    } else {
      // Last resort: gh api without explicit repo path — will fail if cwd isn't
      // a repo, but that's a caller error (same as other gh invocations).
      nodeIdCmd = `gh pr view ${number} --json id --jq '.id'`;
    }
  }
  const prId = exec(nodeIdCmd).trim();

  // Step 2: invoke the enqueuePullRequest mutation
  const mutation = `mutation($prId:ID!){enqueuePullRequest(input:{pullRequestId:$prId}){mergeQueueEntry{position}}}`;
  const repoFlag = repo !== undefined ? `--repo ${repo}` : '';
  const graphqlCmd = `gh api graphql -f query='${mutation}' -f prId="${prId}" ${repoFlag}`.trim();
  const response = exec(graphqlCmd);

  // Parse the response to extract the queue position
  try {
    const data = JSON.parse(response);
    return data?.data?.enqueuePullRequest?.mergeQueueEntry?.position ?? null;
  } catch {
    return null;
  }
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
  queueFallback?: boolean;
  graphqlFallback?: boolean;
  queuePosition?: number | null;
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
    queue_fallback: args.queueFallback === true,
    graphql_fallback: args.graphqlFallback === true,
    queue_position: args.queuePosition,
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

// Read PR state through the routed adapter (Story 1.11 hybrid sub-call). The
// helper unwraps `AdapterResult<PrStateInfo>` into `PrStateInfo` and throws on
// failure so the existing try/catch wrapper in `prMergeGithub` can surface it
// as a typed `unexpected_error`.
async function fetchPrStateRouted(
  number: number,
  repo: string | undefined,
): Promise<PrStateInfo> {
  const result = await getAdapter({ repo }).fetchPrState({ number, repo });
  if ('platform_unsupported' in result) {
    throw new Error(`fetchPrState platform_unsupported: ${result.hint}`);
  }
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

async function mergeGithubViaQueue(
  args: PrMergeArgs,
  queue: PrMergeQueueState,
  warnings: string[],
): Promise<AdapterResult<PrMergeResponse>> {
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
  const info = await fetchPrStateRouted(args.number, args.repo);
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

async function mergeGithubDirect(
  args: PrMergeArgs,
  queue: PrMergeQueueState,
  warnings: string[],
): Promise<AdapterResult<PrMergeResponse>> {
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
    const info = await fetchPrStateRouted(args.number, args.repo);
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
    const indicatesQueue =
      stderrIndicatesMergeQueue(fail.stderr) || stderrIndicatesMergeQueue(fail.message);
    // skip_train callers opt out of the queue path when possible, but a
    // queue-enforced repo (bug #280) will reject the direct merge with a
    // queue-strategy error that detection missed. When the stderr matches,
    // fold skip_train into the same fallback path as non-skip_train — emit
    // the #224 "skip_train ignored" warning and re-invoke with --auto so the
    // PR enrolls instead of surfacing a user-facing error.
    if (args.skip_train === true && !indicatesQueue) {
      return {
        ok: false,
        code: 'gh_pr_merge_skip_train_failed',
        error: `gh pr merge failed (skip_train): ${fail.message}`,
      };
    }
    if (args.skip_train !== true && !indicatesQueue) {
      return {
        ok: false,
        code: 'gh_pr_merge_failed',
        error: `gh pr merge failed: ${fail.message}`,
      };
    }
    if (args.skip_train === true) {
      warnings.push(
        'skip_train ignored — merge queue enforced; merge proceeded via merge_queue strategy',
      );
    }
  }

  // Stderr-fallback path: detection thought no queue, but the API rejected
  // the direct merge with a queue-related error. Try --auto first (the original
  // fallback path from bug #280). If --auto ALSO fails with a queue-related
  // error, fall back to GraphQL enqueuePullRequest (bug #284 — repos with
  // merge-queue-on but enablePullRequestAutoMerge off).
  const fallbackQueue: PrMergeQueueState = { enabled: true, position: null, enforced: true };
  const autoCmd = buildGithubMergeCommand(args.number, true, args.squash_message, args.repo);
  try {
    exec(autoCmd);
    // --auto succeeded — enrolled via the queue. No GraphQL fallback needed.
    const info = await fetchPrStateRouted(args.number, args.repo);
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
        queueFallback: true,
      }),
    };
  } catch (autoErr) {
    const autoFail = extractFailure(autoErr);
    const autoIndicatesQueue =
      stderrIndicatesMergeQueue(autoFail.stderr) ||
      stderrIndicatesMergeQueue(autoFail.message) ||
      autoFail.message.includes('Auto merge is not allowed');
    // If --auto failed for a non-queue reason, surface that error.
    if (!autoIndicatesQueue) {
      return {
        ok: false,
        code: 'gh_pr_merge_auto_fallback_failed',
        error: `gh pr merge --auto failed after merge-queue fallback: ${autoFail.message}`,
      };
    }
    // --auto failed with a queue-related error (bug #284 — merge-queue-on but
    // auto-merge-off). Fall back to GraphQL enqueuePullRequest mutation.
    let queuePosition: number | null = null;
    try {
      queuePosition = enqueuePullRequestViaGraphQL(args.number, args.repo);
    } catch (graphqlErr) {
      return {
        ok: false,
        code: 'gh_pr_enqueue_graphql_failed',
        error: `GraphQL enqueuePullRequest failed after --auto fallback: ${extractFailure(graphqlErr).message}`,
      };
    }
    const info = await fetchPrStateRouted(args.number, args.repo);
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
        queueFallback: true,
        graphqlFallback: true,
        queuePosition,
      }),
    };
  }
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
      ? await mergeGithubViaQueue(args, queue, intent.warnings)
      : await mergeGithubDirect(args, queue, intent.warnings);
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
