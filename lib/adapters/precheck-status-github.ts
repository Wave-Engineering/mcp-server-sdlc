/**
 * GitHub `precheckStatus` adapter (#592): the latest `precheck` commit status
 * on a SHA.
 *
 * Argv: `gh api repos/<slug>/commits/<sha>/status?per_page=100`. The COMBINED
 * status endpoint, which carries only the latest status per context, so a
 * `success` that a later `failure` superseded is never read as a pass. With no
 * `repo`, the `{owner}/{repo}` placeholder lets gh resolve the repo from cwd.
 *
 * FAILS CLOSED (claudecode-workflow docs/precheck-status.md): a non-zero exit,
 * unparseable output, or a body without a `statuses` array is `ok: false`.
 * Only a well-formed answer with no `precheck` entry is `none`.
 */

import { execSync } from 'child_process';
import { runArgv } from '../shared/error-norm.js';
import type { AdapterResult, PrecheckState, PrecheckStatusArgs, PrecheckStatusResponse } from './types.js';
import { GITHUB_REPO_SLUG, SHA_PATTERN, githubSlugPath, projectDir } from './precheck-shared-github.js';

export const PRECHECK_CONTEXT = 'precheck';

function normalize(state: unknown): PrecheckState {
  if (state === 'success') return 'success';
  if (state === 'pending') return 'pending';
  // `failure` and `error` are both "no pass"; anything unrecognised is too.
  return 'failure';
}

export async function precheckStatusGithub(
  args: PrecheckStatusArgs,
): Promise<AdapterResult<PrecheckStatusResponse>> {
  try {
    if (!SHA_PATTERN.test(args.sha)) {
      return { ok: false, code: 'invalid_sha', error: `precheckStatusGithub: invalid sha ${JSON.stringify(args.sha)}` };
    }
    if (args.repo !== undefined && !GITHUB_REPO_SLUG.test(args.repo)) {
      return { ok: false, code: 'invalid_repo', error: `precheckStatusGithub: invalid repo slug ${JSON.stringify(args.repo)}` };
    }
    const cmd = ['gh', 'api', `repos/${githubSlugPath(args.repo)}/commits/${args.sha}/status?per_page=100`];
    const result = runArgv(cmd, projectDir());
    if (result.exitCode !== 0) {
      return {
        ok: false,
        code: 'precheck_status_read_failed',
        error: `could not read the precheck status of ${args.sha}: ${result.stderr.trim() || result.stdout.trim()}`,
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      return { ok: false, code: 'precheck_status_read_failed', error: `precheck status of ${args.sha}: unparseable response` };
    }
    const statuses = (parsed as { statuses?: unknown } | null)?.statuses;
    if (!Array.isArray(statuses)) {
      return { ok: false, code: 'precheck_status_read_failed', error: `precheck status of ${args.sha}: response has no statuses list` };
    }
    const mark = statuses.find(
      (s): s is { context: string; state: unknown } =>
        s !== null && typeof s === 'object' && (s as { context?: unknown }).context === PRECHECK_CONTEXT,
    );
    return { ok: true, data: { state: mark === undefined ? 'none' : normalize(mark.state) } };
  } catch (err) {
    return { ok: false, code: 'unexpected_error', error: err instanceof Error ? err.message : String(err) };
  }
}

// Re-imported so adapter-level tests can intercept this module's subprocess calls.
void execSync;
