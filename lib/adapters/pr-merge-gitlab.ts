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
import {
  directMergeMethodLabel,
  type AdapterResult,
  type PrMergeArgs,
  type PrMergeResponse,
  type MergeMethod,
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

// #488: `ci_must_pass` normally classifies as `blocked` (normalizeGitlabMergeState)
// — correct for `pr_merge`'s deterministic mode, where a merge command refused
// for that reason genuinely IS an immediate block (auto-merge is forced off).
// But `pr_merge_wait`'s ENROLLED mode enrolls specifically so a pending pipeline
// resolves on its own — `ci_must_pass` there means "waiting on CI", not
// "permanently blocked", and misclassifying it would report an in-progress
// enrollment as blocked (enrolled:false) when it is actually just not done yet.
function classifyPostMergeState(mr: GitlabMr, allowPendingCi: boolean): PostMergeState {
  const merged = mr.state === 'merged';
  let blockedReason: string | undefined;
  if (!merged) {
    const cls = normalizeGitlabMergeState(mr.detailed_merge_status, mr.merge_status);
    const isPendingCi = allowPendingCi && mr.detailed_merge_status?.toLowerCase() === 'ci_must_pass';
    if (cls === 'blocked' && !isPendingCi) {
      blockedReason = mr.detailed_merge_status ?? 'blocked_status';
    }
  }
  return { mr, merged, blockedReason };
}

/**
 * Poll the MR until it merges, classifies as genuinely blocked, or the
 * attempt budget runs out — whichever comes first. Throws on a genuine fetch
 * failure, matching how `resolveHeadSha` already handles its own read; the
 * caller converts that into a typed refusal.
 */
async function pollPostMergeState(
  number: number,
  repo: string | undefined,
  allowPendingCi: boolean,
): Promise<PostMergeState> {
  let state = classifyPostMergeState(gitlabApiMr(number, parseSlugOpts(repo)), allowPendingCi);
  for (
    let attempt = 1;
    attempt < MERGE_STATE_POLL_ATTEMPTS && !state.merged && state.blockedReason === undefined;
    attempt += 1
  ) {
    await sleep(MERGE_STATE_POLL_DELAY_MS);
    state = classifyPostMergeState(gitlabApiMr(number, parseSlugOpts(repo)), allowPendingCi);
  }
  return state;
}

// Map the caller-selected method to its `glab mr merge` strategy flag (#474).
// A merge commit is glab's DEFAULT (no flag), so `merge` contributes nothing.
function gitlabMergeFlag(method: MergeMethod): string | null {
  if (method === 'rebase') return '--rebase';
  if (method === 'merge') return null;
  return '--squash';
}

function buildGitlabMergeCommand(
  number: number,
  method: MergeMethod,
  sha: string,
  autoMerge: boolean,
  squashMessage?: string,
  repo?: string,
): string {
  const methodFlag = gitlabMergeFlag(method);
  const parts = [
    'glab',
    'mr',
    'merge',
    String(number),
    // `--squash` for squash, `--rebase` for rebase, nothing for a merge commit.
    ...(methodFlag !== null ? [methodFlag] : []),
    '--remove-source-branch',
    '--yes',
    // #486: `glab mr merge --auto-merge` defaults to TRUE. Left on, an MR with
    // a pending pipeline gets ENROLLED (merge-when-pipeline-succeeds) rather
    // than merged, and this adapter would report `merged: false` /
    // `pr_state: 'OPEN'` while still claiming `merge_method: 'direct_squash'`.
    // The sdlc contract distinguishes merging from enrollment, so `pr_merge`
    // forces the deterministic direct-merge semantics it advertises.
    //
    // #488: `pr_merge_wait` is the one caller that WANTS enrollment — its
    // whole contract is poll-until-merged, so a pipeline-gated MR should
    // enroll rather than fail outright (the wait loop then carries it to
    // completion). `autoMerge` threads that choice through explicitly rather
    // than relying on glab's own default, which #486 already showed is not
    // safe to depend on implicitly.
    `--auto-merge=${autoMerge ? 'true' : 'false'}`,
    // #486: GitLab's stale-head guard. Required (not optional) at the type
    // level so this command can never again be built without a sha.
    '--sha',
    shellEscape(sha),
  ];
  // `--squash-message` is only valid alongside `--squash`; for a merge-commit
  // or rebase it is dropped (squash_message is squash-specific) — #474.
  if (method === 'squash' && squashMessage !== undefined && squashMessage.length > 0) {
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
  // #488: internal-only, set by pr_merge_wait's executor. pr_merge itself
  // never sets this — see PrMergeArgs.allow_gitlab_enrollment for the
  // rationale.
  const allowEnrollment = args.allow_gitlab_enrollment === true;
  // #474: caller-selected merge strategy. `undefined` → `'squash'`, so existing
  // callers keep the pre-#474 `--squash` behavior and `direct_squash` reporting.
  // GitLab has no merge queue, so the direct-path label is always authoritative.
  const method = args.merge_method ?? 'squash';
  const directLabel = directMergeMethodLabel(method);

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

      // #488: ALWAYS attempt the deterministic merge first, regardless of
      // allowEnrollment. Code review on this fix caught that enrolling
      // unconditionally changes behavior on projects that do NOT require a
      // green pipeline: glab's own client-side auto-merge gating refuses on
      // a failed/canceled pipeline and defers on a running one — cases
      // where auto-merge=false merges immediately today. Attempting false
      // first means pr_merge and pr_merge_wait behave IDENTICALLY on every
      // MR that doesn't actually need enrollment; only a genuine
      // pipeline-gated refusal (checked below, by MR state — not by
      // string-matching glab's stderr) falls back to enrollment.
      const cmd = buildGitlabMergeCommand(
        args.number,
        method,
        headSha,
        false,
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
              const postMerge = await pollPostMergeState(args.number, args.repo, allowEnrollment);
              if (postMerge.merged) {
                return {
                  ok: true,
                  data: {
                    number: args.number,
                    enrolled: true,
                    merged: true,
                    merge_method: directLabel,
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

          // #488: the deterministic attempt above was refused. If enrollment
          // is allowed, check WHY via the MR's own detailed_merge_status —
          // more reliable than string-matching glab's stderr, which (unlike
          // GitHub's clean "merge queue" phrasing) has no stable "pipeline
          // gated" marker. Only retry with auto-merge=true when the refusal
          // is genuinely pipeline-related (still transient); any other
          // reason (unmet approvals, conflicts, etc.) is a real refusal that
          // enrollment would not resolve, so it still fails loud below.
          if (allowEnrollment) {
            let pipelinePending = false;
            try {
              const freshMr = gitlabApiMr(args.number, parseSlugOpts(args.repo));
              const dm = freshMr.detailed_merge_status?.toLowerCase();
              pipelinePending =
                dm === 'ci_must_pass' || dm === 'ci_still_running' || dm === 'checking';
            } catch {
              // Can't classify — fall through to the ordinary failure report.
            }
            if (pipelinePending) {
              const retryCmd = buildGitlabMergeCommand(
                args.number,
                method,
                headSha,
                true,
                args.squash_message,
                args.repo,
              );
              try {
                exec(retryCmd);
                merged = true;
              } catch (retryErr) {
                return {
                  ok: false,
                  code: 'glab_mr_merge_failed',
                  error:
                    `glab mr merge failed (auto-merge retry after pipeline-gated refusal): ` +
                    `${extractFailure(retryErr).message}`,
                };
              }
            }
          }

          if (!merged) {
            return {
              ok: false,
              code: 'glab_mr_merge_failed',
              error: `glab mr merge failed: ${failure}`,
            };
          }
          // merged via the enrollment retry above — fall out of the catch and
          // the for-loop (condition `!merged` is now false) to the ordinary
          // post-loop poll, which reports the enrollment honestly.
        } else {
          // Source branch moved mid-merge — loop to refetch the head and retry.
          lastStaleRejection = failure;
        }
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
      postMerge = await pollPostMergeState(args.number, args.repo, allowEnrollment);
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
    // #488: not merged, not blocked, and enrollment was requested — this is
    // GitLab's merge-when-pipeline-succeeds enrollment, the direct analog of
    // GitHub's queue path. Report it honestly: `merge_method: 'direct_squash'`
    // for an MR that never actually merged directly is exactly the dishonest
    // shape #486 removed from the merged case — it must not return through
    // this door for the enrolled case either.
    const isEnrollment = !actuallyMerged && !mergeBlocked && allowEnrollment;

    // #496: post-condition guard. The merge command exited 0, but the server's
    // own MR state does NOT report `merged`, the MR is NOT classified as
    // blocked, and enrollment was never requested. Returning here would report
    // a successful `direct_squash` merge the server cannot confirm — the
    // canonical instance being `glab mr merge` printing `✓ Merged` while the MR
    // was actually ENROLLED (merge-when-pipeline-succeeds) rather than merged.
    // (It also refuses any other not-merged, not-blocked residue — a still
    // `checking` or `conflict` MR the deterministic command left unmerged —
    // rather than the misleading `enrolled:true` shape #461/#424 used to return;
    // see docs/adapters/README.md §10.)
    //
    // Unreachable today only because `--auto-merge=false` is passed
    // unconditionally on this deterministic path; nothing DETECTS the bad state
    // if that flag ever stops taking effect. The risk is live, not theoretical:
    // `--auto-merge` is itself a rename of the older `--when-pipeline-succeeds`,
    // and no fleet survey of glab versions has been done — a future glab that
    // renames or drops it again would silently enroll. The server's `state` is
    // the one witness the client cannot fake (glab prints `✓ Merged` for an
    // enrollment too), so assert on it rather than trust the exit code.
    if (!actuallyMerged && !mergeBlocked && !allowEnrollment) {
      const statusDetail =
        mr.detailed_merge_status !== undefined
          ? ` (detailed_merge_status: \`${mr.detailed_merge_status}\`)`
          : '';
      return {
        ok: false,
        code: 'gitlab_merge_not_confirmed',
        error:
          `glab reported the merge of MR !${String(args.number)} succeeded, but the server ` +
          `does not report it as \`merged\` (state: \`${mr.state}\`${statusDetail}) — refusing to ` +
          `return a successful ${directLabel} envelope for a merge that cannot be confirmed. If a ` +
          `glab upgrade renamed or dropped \`--auto-merge\`, the MR may have been enrolled ` +
          `(merge-when-pipeline-succeeds) rather than merged.`,
      };
    }

    return {
      ok: true,
      data: {
        number: args.number,
        enrolled: !mergeBlocked,
        merged: actuallyMerged,
        merge_method: isEnrollment ? 'merge_queue' : directLabel,
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
