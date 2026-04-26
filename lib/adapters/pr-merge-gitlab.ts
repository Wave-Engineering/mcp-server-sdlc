/**
 * GitLab `pr_merge` adapter implementation.
 *
 * Lifted from `handlers/pr_merge.ts` per Story 1.10 (#247). Mirrors
 * `pr-merge-github.ts` — the handler dispatches to either depending on cwd
 * platform.
 *
 * **Typed asymmetry exemplar (R-03).** `args.skip_train === true` returns
 * `{platform_unsupported: true, hint: ...}` — the HEADLINE behavior the entire
 * platform-adapter retrofit was built around. GitLab has merge trains, but
 * they are auto-managed at the project level — there is no caller-side
 * control equivalent to GitHub's merge queue + skip_train. Pre-retrofit, the
 * handler accepted the flag and silently swallowed it; the typed asymmetry
 * signal closes that leak so MCP callers can branch on the discriminator
 * instead of being lied to.
 *
 * The PR state fetcher (`fetchGitlabMrState`) stays in `lib/pr_state.ts` per
 * Dev Spec §5.3 — this adapter imports from it, it does NOT re-lift it.
 */

import { execSync } from 'child_process';
import { fetchGitlabMrState } from '../pr_state.js';
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
  // R-03 typed-asymmetry exemplar: `skip_train` is meaningless on GitLab
  // (merge trains are auto-managed at the project level — no caller-side
  // control equivalent to GitHub's merge queue + skip_train). Surface the
  // asymmetry as a typed signal so MCP callers can branch on the discriminator
  // instead of being lied to with a fake "merged: true". See Dev Spec §4.4
  // step 4 + the issue #247 description.
  if (args.skip_train === true) {
    return {
      platform_unsupported: true,
      hint: 'merge trains are auto-managed by GitLab; skip_train is GitHub-merge-queue-only',
    };
  }

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
    const info = fetchGitlabMrState(args.number, args.repo);
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
        warnings: [],
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
