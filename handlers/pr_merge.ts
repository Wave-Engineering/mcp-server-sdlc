// Origin Operations family handler.
// See docs/handlers/origin-operations-guide.md for the canonical pattern,
// gh ↔ glab field mappings, and normalized response schemas.

import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { detectPlatform, parseRepoSlug } from '../lib/glab.js';
import { detectMergeQueue, type MergeQueueInfo } from '../lib/merge_queue_detect.js';
import { fetchGithubPrState, fetchGitlabMrState } from '../lib/pr_state.js';

// Codebase convention: child_process.execSync (29/36 handlers). Tests mock it
// via `mock.module('child_process', ...)` — see tests/pr_merge.test.ts.
//
// Multi-line squash messages: we write them to a temp file and pass the path
// via --body-file / --squash-message-file (no shell newline escaping needed).
// Short single-line messages go inline via --body / --squash-message with the
// arg value quoted.

const inputSchema = z.object({
  number: z.number().int().positive('number must be a positive integer'),
  squash_message: z.string().optional(),
  use_merge_queue: z.boolean().optional(),
  skip_train: z.boolean().optional(),
  repo: z
    .string()
    .regex(/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/, 'repo must be owner/repo format')
    .optional(),
});

type Input = z.infer<typeof inputSchema>;
type Platform = 'github' | 'gitlab';
type MergeMethod = 'direct_squash' | 'merge_queue';
type PrStateLabel = 'OPEN' | 'MERGED';

interface QueueState {
  enabled: boolean;
  position: number | null;
  enforced: boolean;
}

interface AggregateResponse {
  ok: true;
  number: number;
  enrolled: boolean;
  merged: boolean;
  merge_method: MergeMethod;
  queue: QueueState;
  pr_state: PrStateLabel;
  url: string;
  merge_commit_sha?: string;
  warnings: string[];
}

interface FailureResponse {
  ok: false;
  error: string;
}

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

function buildGitlabMergeCommand(
  number: number,
  squashMessage?: string,
  repo?: string,
): string {
  const parts = [
    'glab',
    'mr',
    'merge',
    String(number),
    '--squash',
    '--remove-source-branch',
    '--yes',
  ];
  if (squashMessage !== undefined && squashMessage.length > 0) {
    parts.push('--squash-message', shellEscape(squashMessage));
  }
  return repo !== undefined ? `${parts.join(' ')} -R ${repo}` : parts.join(' ');
}

// Resolve the repo slug for queue detection. Prefer the explicit input; fall
// back to the cwd remote; null if neither yields a usable slug. When null,
// queue detection is skipped (treated as no queue) and the legacy stderr
// fallback remains the only path into the queue.
function resolveRepoSlug(args: Input): string | null {
  if (args.repo !== undefined) return args.repo;
  return parseRepoSlug();
}

function emptyQueue(): QueueState {
  return { enabled: false, position: null, enforced: false };
}

function queueFromInfo(info: MergeQueueInfo): QueueState {
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
  method: MergeMethod;
  queue: QueueState;
  url: string;
  mergeCommitSha?: string;
  warnings: string[];
}): AggregateResponse {
  return {
    ok: true,
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
  args: Input,
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
  args: Input,
  queue: QueueState,
  warnings: string[],
): AggregateResponse | FailureResponse {
  const cmd = buildGithubMergeCommand(args.number, true, args.squash_message, args.repo);
  try {
    exec(cmd);
  } catch (err) {
    return {
      ok: false,
      error: `gh pr merge --auto failed: ${extractFailure(err).message}`,
    };
  }
  // Queue enrollment is eager: gh returns immediately, the PR remains OPEN
  // until the queue rebases + reruns CI + lands. Honest reporting per #225:
  // enrolled but not yet merged.
  const info = fetchGithubPrState(args.number, args.repo);
  return aggregateOk({
    number: args.number,
    enrolled: true,
    merged: info.state === 'merged',
    method: 'merge_queue',
    queue,
    url: info.url,
    mergeCommitSha: info.mergeCommitSha,
    warnings,
  });
}

function mergeGithubDirect(
  args: Input,
  queue: QueueState,
  warnings: string[],
): AggregateResponse | FailureResponse {
  const directCmd = buildGithubMergeCommand(
    args.number,
    false,
    args.squash_message,
    args.repo,
  );
  try {
    exec(directCmd);
    const info = fetchGithubPrState(args.number, args.repo);
    return aggregateOk({
      number: args.number,
      enrolled: true,
      merged: true,
      method: 'direct_squash',
      queue,
      url: info.url,
      mergeCommitSha: info.mergeCommitSha,
      warnings,
    });
  } catch (err) {
    const fail = extractFailure(err);
    if (args.skip_train === true) {
      return {
        ok: false,
        error: `gh pr merge failed (skip_train): ${fail.message}`,
      };
    }
    if (
      !stderrIndicatesMergeQueue(fail.stderr) &&
      !stderrIndicatesMergeQueue(fail.message)
    ) {
      return {
        ok: false,
        error: `gh pr merge failed: ${fail.message}`,
      };
    }
  }

  // Stderr-fallback path: detection thought no queue, but the API rejected
  // the direct merge with a queue-related error. Promote the queue state so
  // the response reflects what we just learned.
  const fallbackQueue: QueueState = { enabled: true, position: null, enforced: true };
  const autoCmd = buildGithubMergeCommand(args.number, true, args.squash_message, args.repo);
  try {
    exec(autoCmd);
  } catch (err) {
    return {
      ok: false,
      error: `gh pr merge --auto failed after merge-queue fallback: ${extractFailure(err).message}`,
    };
  }
  const info = fetchGithubPrState(args.number, args.repo);
  return aggregateOk({
    number: args.number,
    enrolled: true,
    merged: info.state === 'merged',
    method: 'merge_queue',
    queue: fallbackQueue,
    url: info.url,
    mergeCommitSha: info.mergeCommitSha,
    warnings,
  });
}

function mergeGithub(args: Input): AggregateResponse | FailureResponse {
  const slug = resolveRepoSlug(args);
  const mqInfo = slug !== null ? detectMergeQueue(slug) : { enabled: false, enforced: false };
  const queue = queueFromInfo(mqInfo);
  const intent = decideIntent(args, mqInfo);

  return intent.useQueue
    ? mergeGithubViaQueue(args, queue, intent.warnings)
    : mergeGithubDirect(args, queue, intent.warnings);
}

function mergeGitlab(args: Input): AggregateResponse | FailureResponse {
  // GitLab has no merge-queue concept; queue stays empty.
  const cmd = buildGitlabMergeCommand(args.number, args.squash_message, args.repo);
  try {
    exec(cmd);
  } catch (err) {
    return {
      ok: false,
      error: `glab mr merge failed: ${extractFailure(err).message}`,
    };
  }
  const info = fetchGitlabMrState(args.number, args.repo);
  return aggregateOk({
    number: args.number,
    enrolled: true,
    merged: info.state === 'merged',
    method: 'direct_squash',
    queue: emptyQueue(),
    url: info.url,
    mergeCommitSha: info.mergeCommitSha,
    warnings: [],
  });
}

export function performMerge(
  platform: Platform,
  args: Input,
): AggregateResponse | FailureResponse {
  return platform === 'github' ? mergeGithub(args) : mergeGitlab(args);
}

const prMergeHandler: HandlerDef = {
  name: 'pr_merge',
  description:
    'Merge a PR/MR with squash + delete source branch. Returns the AGGREGATE state — ' +
    '{enrolled, merged, merge_method, queue:{enabled,position,enforced}, pr_state, warnings} — ' +
    'so the caller decides what "merged" means for their use case. On a merge-queue-enforced repo ' +
    'the response is eager: enrolled=true, merged=false, pr_state="OPEN" (the PR is queued, not yet ' +
    'on main). For "block until commit lands on main", use pr_merge_wait. ' +
    'skip_train=true bypasses the queue when commutativity_verify has proven the merge safe, except ' +
    'on queue-enforced repos where the flag is silently dropped (warning emitted).',
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
      const result = performMerge(platform, args);
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

export default prMergeHandler;
