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
 * Story 1.11 (#248) routes the post-merge state lookup through
 * `getAdapter().fetchPrState(...)` — the FIRST hybrid sub-call dispatched
 * via the platform adapter — instead of importing `lib/pr_state.ts` directly.
 */

import { execSync } from 'child_process';
import { gitlabApiMr } from '../gitlab-api.js';
import { getAdapter } from './index.js';
import { normalizeGitlabMergeState } from './pr-status-gitlab.js';
import type {
  AdapterResult,
  PrMergeArgs,
  PrMergeResponse,
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
          if (isBranchDeleteFailure(failure)) {
            const stateResult = await getAdapter({ repo: args.repo }).fetchPrState({
              number: args.number,
              repo: args.repo,
            });
            if (
              !('platform_unsupported' in stateResult) &&
              stateResult.ok &&
              stateResult.data.state === 'merged'
            ) {
              const info = stateResult.data;
              return {
                ok: true,
                data: {
                  number: args.number,
                  enrolled: true,
                  merged: true,
                  merge_method: 'direct_squash',
                  queue: { enabled: false, position: null, enforced: false },
                  pr_state: 'MERGED',
                  url: info.url,
                  merge_commit_sha: info.mergeCommitSha,
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
    const stateResult = await getAdapter({ repo: args.repo }).fetchPrState({
      number: args.number,
      repo: args.repo,
    });
    if ('platform_unsupported' in stateResult) {
      return {
        ok: false,
        code: 'fetch_pr_state_platform_unsupported',
        error: `fetchPrState platform_unsupported: ${stateResult.hint}`,
      };
    }
    if (!stateResult.ok) {
      return { ok: false, code: stateResult.code, error: stateResult.error };
    }
    const info: PrStateInfo = stateResult.data;
    const actuallyMerged = info.state === 'merged';

    // #461: `glab mr merge` can exit 0 without merging — e.g. an MR blocked on
    // required approvals, unresolved discussions, or draft status. That left
    // the caller with `enrolled:true, merged:false`, indistinguishable from
    // legitimate queue enrollment (GitHub's shape). GitLab has no queue
    // concept, so re-check the MR's own `detailed_merge_status` and surface
    // the blocker by name instead of making the caller round-trip pr_status
    // to discover it. Reuses `normalizeGitlabMergeState` — the canonical
    // classification `pr-status-gitlab.ts` already carries — rather than
    // re-deriving a narrower, incomplete subset here. Best-effort: if the
    // re-fetch itself fails, fall through with the pre-#461 shape rather than
    // failing a merge attempt whose real outcome we already know.
    let blockedReason: string | undefined;
    if (!actuallyMerged) {
      try {
        const freshMr = gitlabApiMr(args.number, parseSlugOpts(args.repo));
        const state = normalizeGitlabMergeState(freshMr.detailed_merge_status, freshMr.merge_status);
        if (state === 'blocked') {
          blockedReason = freshMr.detailed_merge_status ?? 'blocked_status';
        }
      } catch {
        // best-effort — see comment above
      }
    }
    const mergeBlocked = blockedReason !== undefined;

    return {
      ok: true,
      data: {
        number: args.number,
        // A blocked MR is not enrollment — nothing is in progress, the MR is
        // simply blocked, and `enrolled:true` would misleadingly imply otherwise.
        enrolled: !mergeBlocked,
        merged: actuallyMerged,
        merge_method: 'direct_squash',
        queue: { enabled: false, position: null, enforced: false },
        pr_state: actuallyMerged ? 'MERGED' : 'OPEN',
        url: info.url,
        merge_commit_sha: info.mergeCommitSha,
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
