/**
 * GitHub half of the wave trust gate's freshness anchor (#476).
 *
 * A `pull_request` workflow run reports `head_sha` == the PR's head commit — NOT
 * the ephemeral merge commit. (Verified against a live PR: `pulls/N.head.sha`
 * equals the run's `headSha`.) The ephemeral-merge-commit `head_sha` is a
 * GitLab-only property; assuming it on GitHub throws away a perfectly good
 * anchor, which is exactly how the gate ended up able to grade a stale run.
 */

import { runArgv } from '../shared/error-norm.js';
import type {
  AdapterResult,
  MergeAnchor,
  ResolveMergeAnchorArgs,
} from './types.js';

const GITHUB_REPO_SLUG = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;

function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

export async function resolveMergeAnchorGithub(
  args: ResolveMergeAnchorArgs,
): Promise<AdapterResult<MergeAnchor>> {
  if (!Number.isInteger(args.number) || args.number <= 0) {
    return {
      ok: false,
      code: 'invalid_number',
      error: `resolveMergeAnchorGithub: invalid PR number ${JSON.stringify(args.number)}`,
    };
  }
  if (args.repo !== undefined && !GITHUB_REPO_SLUG.test(args.repo)) {
    return {
      ok: false,
      code: 'invalid_repo',
      error: `resolveMergeAnchorGithub: invalid repo slug ${JSON.stringify(args.repo)}`,
    };
  }

  const cmd = ['gh', 'pr', 'view', String(args.number), '--json', 'headRefOid'];
  if (args.repo !== undefined) cmd.push('--repo', args.repo);

  const result = runArgv(cmd, projectDir());
  if (result.exitCode !== 0) {
    return {
      ok: false,
      code: 'gh_pr_view_failed',
      error: `gh pr view failed: ${result.stderr.trim() || result.stdout.trim()}`,
    };
  }

  let headSha: unknown;
  try {
    headSha = (JSON.parse(result.stdout) as { headRefOid?: unknown }).headRefOid;
  } catch (err) {
    return {
      ok: false,
      code: 'gh_pr_view_unparseable',
      error: `gh pr view returned unparseable JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (typeof headSha !== 'string' || !SHA_PATTERN.test(headSha)) {
    return {
      ok: false,
      code: 'no_head_sha',
      // Fail closed: without the anchor we cannot prove the run we grade
      // corresponds to the commit under test.
      error: `PR #${args.number} did not report a head SHA — cannot anchor the merge-result run to the commit under test`,
    };
  }

  return { ok: true, data: { head_sha: headSha.toLowerCase() } };
}
