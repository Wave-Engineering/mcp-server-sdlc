/**
 * GitHub `work_item` adapter implementation.
 *
 * Lifted from `handlers/work_item.ts` per Story 2.17 (#311). Unifies what was
 * two GitHub-specific functions (`createGithubIssue`, `createGithubPR`) into a
 * single adapter method that picks the right `gh` sub-command internally based
 * on `args.type`.
 *
 * Cross-platform asymmetry (R-03 / #281):
 *   - `type: 'mr'` is a GitLab concept. This adapter returns
 *     `{platform_unsupported: true, hint: 'use type="pr" on GitHub'}` rather
 *     than silently succeeding OR running the wrong sub-command (the
 *     pre-migration bug that #281 tracked).
 *
 * Argv composition:
 *   Issue types (epic | story | bug | chore | docs | feature | fix):
 *     gh issue create
 *       --title <title>
 *       --body <body>
 *       [--label <label>]...          // repeated; includes auto `type::<type>`
 *       [--repo <owner/repo>]
 *
 *   `type: 'pr'`:
 *     gh pr create
 *       --title <title>
 *       --body <body>
 *       [--head <branch>]
 *       [--base <branch>]
 *       [--draft]
 *       [--label <label>]...          // caller-supplied; NO auto type label
 *       [--repo <owner/repo>]
 */

import { execSync } from 'child_process';
import { runArgv } from '../shared/error-norm.js';
import type {
  AdapterResult,
  WorkItemArgs,
  WorkItemResponse,
} from './types.js';

function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

const ISSUE_TYPE_LABELS: Record<string, string | null> = {
  epic: 'type::epic',
  story: 'type::story',
  feature: 'type::feature',
  bug: 'type::bug',
  chore: 'type::chore',
  docs: 'type::docs',
  fix: 'type::fix',
  pr: null,
  mr: null,
};

function isIssueType(type: string): boolean {
  return type !== 'pr' && type !== 'mr';
}

/**
 * Parse `{url, number}` from a `gh issue/pr create` success payload. Both
 * commands print the created item's URL on their last line of stdout; the
 * trailing path segment is the numeric id.
 */
function parseGhOutput(stdout: string): WorkItemResponse {
  const lines = stdout.trim().split('\n');
  const url = lines[lines.length - 1].trim();
  const match = url.match(/\/(\d+)$/);
  const number = match ? parseInt(match[1], 10) : 0;
  return { url, number };
}

export async function workItemGithub(
  args: WorkItemArgs,
): Promise<AdapterResult<WorkItemResponse>> {
  // Cross-platform asymmetry — `mr` is GitLab-only. Per #281, we surface this
  // as a typed signal rather than running the wrong sub-command.
  if (args.type === 'mr') {
    return {
      platform_unsupported: true,
      hint: 'use type="pr" on GitHub',
    };
  }

  try {
    const cwd = projectDir();
    const body = args.body ?? '';

    if (isIssueType(args.type)) {
      const cmd = ['gh', 'issue', 'create', '--title', args.title, '--body', body];
      const autoLabel = ISSUE_TYPE_LABELS[args.type];
      const labels = autoLabel ? [autoLabel, ...(args.labels ?? [])] : [...(args.labels ?? [])];
      for (const label of labels) {
        cmd.push('--label', label);
      }
      if (args.repo !== undefined) cmd.push('--repo', args.repo);

      const result = runArgv(cmd, cwd);
      if (result.exitCode !== 0) {
        return {
          ok: false,
          code: 'gh_issue_create_failed',
          error: `gh issue create failed: ${result.stderr.trim() || result.stdout.trim()}`,
        };
      }
      return { ok: true, data: parseGhOutput(result.stdout) };
    }

    // args.type === 'pr'
    const cmd = ['gh', 'pr', 'create', '--title', args.title, '--body', body];
    if (args.head_branch !== undefined) cmd.push('--head', args.head_branch);
    if (args.base_branch !== undefined) cmd.push('--base', args.base_branch);
    if (args.draft) cmd.push('--draft');
    for (const label of args.labels ?? []) {
      cmd.push('--label', label);
    }
    if (args.repo !== undefined) cmd.push('--repo', args.repo);

    const result = runArgv(cmd, cwd);
    if (result.exitCode !== 0) {
      return {
        ok: false,
        code: 'gh_pr_create_failed',
        error: `gh pr create failed: ${result.stderr.trim() || result.stdout.trim()}`,
      };
    }
    return { ok: true, data: parseGhOutput(result.stdout) };
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
