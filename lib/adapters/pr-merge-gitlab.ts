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
import { getAdapter } from './index.js';
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

export async function prMergeGitlab(
  args: PrMergeArgs,
): Promise<AdapterResult<PrMergeResponse>> {
  // #423: `skip_train` is meaningless on GitLab (merge trains are
  // auto-managed at the project level). Silently drop it and proceed with the
  // merge — callers pass the flag unconditionally and expect the adapter to
  // handle the asymmetry without short-circuiting.
  const skippedTrain = args.skip_train === true;

  try {
    // GitLab has no merge-queue concept; queue stays empty.
    const cmd = buildGitlabMergeCommand(args.number, args.squash_message, args.repo);
    try {
      exec(cmd);
    } catch (err) {
      return {
        ok: false,
        code: 'glab_mr_merge_failed',
        error: `glab mr merge failed: ${extractFailure(err).message}`,
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
    return {
      ok: true,
      data: {
        number: args.number,
        enrolled: true,
        merged: info.state === 'merged',
        merge_method: 'direct_squash',
        queue: { enabled: false, position: null, enforced: false },
        pr_state: info.state === 'merged' ? 'MERGED' : 'OPEN',
        url: info.url,
        merge_commit_sha: info.mergeCommitSha,
        warnings: skippedTrain
          ? ['skip_train ignored on GitLab — merge trains are auto-managed at the project level']
          : [],
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
