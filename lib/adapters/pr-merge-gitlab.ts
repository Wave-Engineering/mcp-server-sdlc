/**
 * GitLab `pr_merge` adapter implementation.
 *
 * Lifted from `handlers/pr_merge.ts` per Story 1.10 (#247). Mirrors
 * `pr-merge-github.ts` — the handler dispatches to either depending on cwd
 * platform.
 *
 * `skip_train` is silently dropped (#423): GitLab merge trains are
 * auto-managed at the project level — there is no caller-side equivalent to
 * GitHub's merge queue + skip_train. Callers pass the flag unconditionally
 * and the adapter proceeds with the merge, surfacing a warning in the
 * response rather than short-circuiting with `platform_unsupported`.
 *
 * Story 1.11 (#248) originally routed the post-merge state lookup through
 * `getAdapter().fetchPrState(...)` — the FIRST hybrid sub-call dispatched via
 * the platform adapter. #424 replaced every post-merge state read in this
 * file with `pollPostMergeState`, which reads via `gitlabApiMr` directly
 * (like `resolveHeadSha` already did): it needs the GitLab-specific
 * `detailed_merge_status` field the routed `PrStateInfo` shape doesn't carry,
 * and it needs to retry — both false economy through the generic hybrid path.
 * The routing pattern itself stays valid elsewhere; this file just no longer
 * uses it.
 */

import { execSync } from 'child_process';
import { gitlabApiMr, type GitlabMr } from '../gitlab-api.js';
import { normalizeGitlabMergeState } from './pr-status-gitlab.js';
import type {
  AdapterResult,
  PrMergeArgs,
  PrMergeResponse,
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

function exec(cmd: string): string {
  return execSync(cmd, { encoding: 'utf8' });
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Split an `owner/repo` slug for the `gitlabApiMr` wrapper. Mirrors the same
 * helper in `fetch-pr-state-gitlab.ts` — splits on the FIRST `/`, so arbitrarily
 * deep group nesting (`org/a/b/c/repo`) recombines losslessly and is
 * `encodeURIComponent`d whole by `projectPath()`.
 */
function parseSlugOpts(
  slug: string | undefined,
): { owner?: string; repo?: string } | undefined {
  if (slug === undefined) return undefined;
  const idx = slug.indexOf('/');
  if (idx <= 0 || idx === slug.length - 1) return undefined;
  return { owner: slug.slice(0, idx), repo: slug.slice(idx + 1) };
}

/**
 * Resolve the MR's source-branch HEAD sha (#486).
 *
 * GitLab's merge endpoint requires `sha` as a stale-head guard when the project
 * enforces pipelines-must-succeed and/or squash; without it the API rejects the
 * merge with `400 SHA must be provided when merging`. `glab mr merge` does not
 * supply it for us, so we resolve it and pass `--sha` explicitly.
 *
 * Deliberately reads `sha` (the diff head) and NOT `merge_commit_sha`, which is
 * the commit produced *by* a merge and is null before one happens.
 *
 * Throws when unresolvable — the caller converts that into a typed refusal.
 * Never fall back to merging without a sha: that is precisely the silent
 * degradation that produced this bug.
 */
function resolveHeadSha(number: number, repo?: string): string {
  const mr = gitlabApiMr(number, parseSlugOpts(repo));
  // `diff_refs.head_sha` is the canonical source-branch HEAD; the top-level
  // `sha` is the same value and serves as the fallback.
  const sha = mr.diff_refs?.head_sha ?? mr.sha ?? undefined;
  if (typeof sha !== 'string' || sha.trim().length === 0) {
    throw new Error(
      'merge request carries no source-branch head sha (both `diff_refs.head_sha` and `sha` absent)',
    );
  }
  return sha.trim();
}

// Detect a post-merge branch-deletion failure (#497). `glab mr merge
// --remove-source-branch` performs merge then deletion in one round-trip: if
// deletion fails after the merge commits the command exits non-zero. Verify
// actual state; if merged, surface the deletion error as a warning (#497).
function isBranchDeleteFailure(text: string): boolean {
  return /failed to delete (remote |source )?branch/i.test(text) ||
    /could not delete (remote |source )?branch/i.test(text);
}

/**
 * True when a failed merge is GitLab rejecting our stale-head guard — i.e. the
 * source branch moved between resolving the sha and issuing the merge (#486).
 * GitLab answers `409 SHA does not match HEAD of source branch`.
 *
 * This is the inherent TOCTOU window in the two-step fetch-then-merge. It is
 * transient and correctly retried by re-resolving the sha, NOT fatal.
 */
function isStaleShaRejection(message: string): boolean {
  // GitLab's documented rejection text — the primary signal.
  if (/sha does not match/i.test(message)) return true;

  // Secondary: a 409 STATUS, matched in its structural position. glab renders
  // failures as `<VERB> <url>: <status> {message: ...}`, so the status is always
  // followed by the response body's `{`.
  //
  // A bare /\b409\b/ is WRONG here and was a real bug: glab's error text echoes
  // the request URL, which contains the MR IID (`.../merge_requests/409/merge`).
  // So merging MR !409 matched on its own IID and misclassified ANY failure —
  // a genuine 405 conflict included — as a stale-head race, retried it, and
  // then reported `gitlab_head_sha_moved`. It also fired on unrelated text
  // carrying a standalone 409, e.g. a branch named `fix/409-something`.
  //
  // That is the same defect this PR exists to remove: asserting a cause the
  // evidence does not support. Requiring the `{` anchors the match to the
  // status field, which a URL path segment can never satisfy.
  return /\b409\s*\{/.test(message);
}

/** Attempts of resolve-sha → merge before a stale-head rejection becomes fatal. */
const MAX_SHA_ATTEMPTS = 2;

// #424: after `glab mr merge` exits 0, GitLab's own state can lag the merge
// command by a beat — the merge genuinely completes but the very next MR read
// still shows `state: 'opened'`. Reproduced live: two parallel MRs in the same
// wave flight, one read back `merged:true` immediately, the other (merged
// moments earlier by wall clock) read back `merged:false` — a read-after-write
// race, not a real failure. A single unretried read cannot tell "still racing"
// from "genuinely not merged", so poll briefly before trusting a not-merged
// read. Bounded: on the common case (state already settled) this adds zero
// delay — the first read already sees `merged`.
//
// Polling stops the moment the MR classifies as `blocked` (#461's
// `normalizeGitlabMergeState`), not just on `merged` — a `not_approved` MR is
// never going to resolve to `merged` by waiting a few hundred ms, so treating
// it the same as a genuine race would burn the whole poll budget for nothing.
// Reads via `gitlabApiMr` directly (as `resolveHeadSha` above already does)
// rather than the routed `fetchPrState`: `detailed_merge_status` is a
// GitLab-specific field the cross-platform `PrStateInfo` shape doesn't carry,
// and the blocked-reason check needs it from the SAME read the poll already
// made, not a second round-trip per attempt.
const MERGE_STATE_POLL_ATTEMPTS = 4;
const MERGE_STATE_POLL_DELAY_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface PostMergeState {
  mr: GitlabMr;
  merged: boolean;
  /** Set when classified `blocked` (not_approved, discussions_not_resolved, etc). */
  blockedReason: string | undefined;
}

function classifyPostMergeState(mr: GitlabMr): PostMergeState {
  const merged = mr.state === 'merged';
  let blockedReason: string | undefined;
  if (!merged) {
    const cls = normalizeGitlabMergeState(mr.detailed_merge_status, mr.merge_status);
    if (cls === 'blocked') blockedReason = mr.detailed_merge_status ?? 'blocked_status';
  }
  return { mr, merged, blockedReason };
}

/**
 * Poll the MR until it merges, classifies as genuinely blocked, or the
 * attempt budget runs out — whichever comes first. Throws on a genuine fetch
 * failure, matching how `resolveHeadSha` already handles its own read; the
 * caller converts that into a typed refusal.
 */
async function pollPostMergeState(number: number, repo: string | undefined): Promise<PostMergeState> {
  let state = classifyPostMergeState(gitlabApiMr(number, parseSlugOpts(repo)));
  for (
    let attempt = 1;
    attempt < MERGE_STATE_POLL_ATTEMPTS && !state.merged && state.blockedReason === undefined;
    attempt += 1
  ) {
    await sleep(MERGE_STATE_POLL_DELAY_MS);
    state = classifyPostMergeState(gitlabApiMr(number, parseSlugOpts(repo)));
  }
  return state;
}

function buildGitlabMergeCommand(
  number: number,
  sha: string,
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
    // #486: `glab mr merge --auto-merge` defaults to TRUE. Left on, an MR with
    // a pending pipeline gets ENROLLED (merge-when-pipeline-succeeds) rather
    // than merged, and this adapter would report `merged: false` /
    // `pr_state: 'OPEN'` while still claiming `merge_method: 'direct_squash'`.
    // The sdlc contract distinguishes merging from enrollment, so we force the
    // deterministic direct-merge semantics this adapter advertises.
    '--auto-merge=false',
    // #486: GitLab's stale-head guard. Required (not optional) at the type
    // level so this command can never again be built without a sha.
    '--sha',
    shellEscape(sha),
  ];
  if (squashMessage !== undefined && squashMessage.length > 0) {
    parts.push('--squash-message', shellEscape(squashMessage));
  }
  // #408: `repo` reaches a shell via execSync, so it MUST be escaped like every
  // other interpolated value here (`squash_message`, `sha`). It was the one
  // caller-supplied field interpolated raw.
  return repo !== undefined
    ? `${parts.join(' ')} -R ${shellEscape(repo)}`
    : parts.join(' ');
}

export async function prMergeGitlab(
  args: PrMergeArgs,
): Promise<AdapterResult<PrMergeResponse>> {
  // #423: `skip_train` is meaningless on GitLab (merge trains are
  // auto-managed at the project level). Silently drop it and proceed with the
  // merge — callers pass the flag unconditionally and expect the adapter to
  // handle the asymmetry without short-circuiting.
  const skippedTrain = args.skip_train === true;

  try {
    // #486: two-step merge. Resolve the source-branch HEAD sha, then merge with
    // it as GitLab's stale-head guard. Namespaces with `require_sha_for_merge`
    // (now the DEFAULT for newly-created GitLab groups) reject an unguarded
    // merge with `400 SHA must be provided when merging`.
    //
    // Between resolving the sha and issuing the merge the branch can move —
    // an inherent TOCTOU window. GitLab then answers `409 SHA does not match`,
    // which is transient: re-resolve and retry rather than failing the caller.
    // GitLab has no merge-queue concept; queue stays empty.
    let merged = false;
    let lastStaleRejection = '';
    // Bound is structural: falling out of the loop without `merged` can only
    // mean every attempt hit a stale-head rejection, which the explicit
    // post-loop return names. No path exits this block without a result.
    for (let attempt = 1; attempt <= MAX_SHA_ATTEMPTS && !merged; attempt += 1) {
      let headSha: string;
      try {
        headSha = resolveHeadSha(args.number, args.repo);
      } catch (err) {
        return {
          ok: false,
          code: 'gitlab_head_sha_unresolved',
          error:
            `could not resolve source-branch head sha for MR !${String(args.number)}: ` +
            `${extractFailure(err).message}. GitLab requires \`sha\` as a stale-head guard when ` +
            'merging; refusing to merge without it.',
        };
      }

      const cmd = buildGitlabMergeCommand(
        args.number,
        headSha,
        args.squash_message,
        args.repo,
      );
      try {
        exec(cmd);
        merged = true;
      } catch (err) {
        const failure = extractFailure(err).message;
        if (!isStaleShaRejection(failure)) {
          // Branch deletion is post-merge cleanup (#497). Verify actual state;
          // if the MR merged despite the error, surface it as a warning.
          // #424: reuses the same race-hardened poll as the main success
          // path — this read sits in the identical propagation-lag window
          // (merge landed, THEN deletion failed), so an unretried single
          // read here was exposed to the exact race #424 exists to close,
          // and a lagged read would have misreported a landed merge as
          // `glab_mr_merge_failed` — worse than the bug #424 fixes, since
          // that's ok:false for a merge that actually succeeded.
          if (isBranchDeleteFailure(failure)) {
            try {
              const postMerge = await pollPostMergeState(args.number, args.repo);
              if (postMerge.merged) {
                return {
                  ok: true,
                  data: {
                    number: args.number,
                    enrolled: true,
                    merged: true,
                    merge_method: 'direct_squash',
                    queue: { enabled: false, position: null, enforced: false },
                    pr_state: 'MERGED',
                    url: postMerge.mr.web_url,
                    merge_commit_sha: postMerge.mr.merge_commit_sha ?? undefined,
                    warnings: [
                      ...(skippedTrain
                        ? ['skip_train ignored on GitLab — merge trains are auto-managed at the project level']
                        : []),
                      `branch deletion failed after successful merge (cosmetic — the merge landed): ${failure}`,
                    ],
                    queue_fallback: false,
                    graphql_fallback: false,
                  },
                };
              }
            } catch {
              // A read failure here doesn't change what we already know: the
              // merge COMMAND itself exited non-zero, unlike the main poll's
              // read failure (where the command succeeded and the read WAS
              // the only ground truth). Fall through to the existing
              // glab_mr_merge_failed report below — no new uncertainty.
            }
          }
          return {
            ok: false,
            code: 'glab_mr_merge_failed',
            error: `glab mr merge failed: ${failure}`,
          };
        }
        // Source branch moved mid-merge — loop to refetch the head and retry.
        lastStaleRejection = failure;
      }
    }

    if (!merged) {
      // Distinct from `glab_mr_merge_failed` on purpose: the caller must be able
      // to tell "the branch kept moving under us" from "this MR cannot merge"
      // without string-matching an error message.
      return {
        ok: false,
        code: 'gitlab_head_sha_moved',
        error:
          `MR !${String(args.number)} source branch moved during each of ` +
          `${String(MAX_SHA_ATTEMPTS)} merge attempts (GitLab rejected the stale-head guard ` +
          `each time); last rejection: ${lastStaleRejection}`,
      };
    }
    // #424/#461: poll for the settled state (racing propagation vs a genuine
    // block resolve differently — see pollPostMergeState) in one pass, rather
    // than a single unretried read followed by a second separate diagnostic
    // call. Best-effort at the network layer: a fetch failure here is a real
    // error (unlike the merge command itself, which already succeeded), so it
    // surfaces as a typed refusal rather than silently reporting a stale shape.
    let postMerge: PostMergeState;
    try {
      postMerge = await pollPostMergeState(args.number, args.repo);
    } catch (err) {
      return {
        ok: false,
        code: 'gitlab_mr_state_fetch_failed',
        error:
          `the merge command succeeded; could not read MR state to confirm — do not retry the ` +
          `merge: ${extractFailure(err).message}`,
      };
    }
    const { mr, merged: actuallyMerged, blockedReason } = postMerge;
    // A blocked MR is not enrollment — nothing is in progress, the MR is
    // simply blocked, and `enrolled:true` would misleadingly imply otherwise.
    const mergeBlocked = blockedReason !== undefined;

    return {
      ok: true,
      data: {
        number: args.number,
        enrolled: !mergeBlocked,
        merged: actuallyMerged,
        merge_method: 'direct_squash',
        queue: { enabled: false, position: null, enforced: false },
        pr_state: actuallyMerged ? 'MERGED' : 'OPEN',
        url: mr.web_url,
        merge_commit_sha: mr.merge_commit_sha ?? undefined,
        warnings: [
          ...(skippedTrain
            ? ['skip_train ignored on GitLab — merge trains are auto-managed at the project level']
            : []),
          ...(mergeBlocked ? [`merge blocked: ${blockedReason}`] : []),
        ],
        // GitLab has no queue concept — queue_fallback always false. Required
        // by PrMergeResponse since bug #280 / #294 added the field.
        queue_fallback: false,
        // GitLab has no GraphQL enqueuePullRequest — graphql_fallback always
        // false. Required by PrMergeResponse since bug #284 added the field.
        graphql_fallback: false,
      },
    };
  } catch (err) {
    return {
      ok: false,
      code: 'unexpected_error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// See pr-merge-github.ts for the rationale.
void execSync;
