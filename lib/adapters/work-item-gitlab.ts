/**
 * GitLab `work_item` adapter implementation.
 *
 * Lifted from `handlers/work_item.ts` per Story 2.17 (#311). Unifies what was
 * two GitLab-specific functions (`createGitlabIssue`, `createGitlabMR`) into a
 * single adapter method that picks the right `glab` sub-command internally
 * based on `args.type`.
 *
 * Cross-platform asymmetry (R-03 / #281):
 *   - `type: 'pr'` is a GitHub concept. This adapter returns
 *     `{platform_unsupported: true, hint: 'use type="mr" on GitLab'}` rather
 *     than silently succeeding OR running the wrong sub-command (the
 *     pre-migration bug — `createGithubPR` ran against a GitLab origin).
 *
 * Argv composition:
 *   Issue types (epic | story | bug | chore | docs | feature | fix):
 *     glab issue create
 *       --title <title>
 *       --description <body>
 *       [--label <csv>]               // glab takes a comma-separated list
 *       [-R <owner/repo>]             // glab uses short `-R`, NOT `--repo`
 *
 *   `type: 'mr'`:
 *     glab mr create
 *       --title <title>
 *       --description <body>
 *       [--source-branch <branch>]
 *       [--target-branch <branch>]
 *       [--draft]
 *       [--label <csv>]
 *       [-R <owner/repo>]
 *
 * Argv strictness per `lesson_origin_ops_pitfalls.md`: glab rejects GitHub-style
 * `--repo` and `--body-file`; this adapter uses `-R` and `--description <body>`.
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
 * Parse `{url, number}` from a `glab issue/mr create` success payload. Both
 * commands print the created item's URL on their last line of stdout; the
 * trailing path segment is the numeric id.
 */
function parseGlabOutput(stdout: string): WorkItemResponse {
  const lines = stdout.trim().split('\n');
  const url = lines[lines.length - 1].trim();
  const match = url.match(/\/(\d+)$/);
  const number = match ? parseInt(match[1], 10) : 0;
  return { url, number };
}

export async function workItemGitlab(
  args: WorkItemArgs,
): Promise<AdapterResult<WorkItemResponse>> {
  // Cross-platform asymmetry — `pr` is GitHub-only. Per #281, we surface this
  // as a typed signal rather than running the wrong sub-command.
  if (args.type === 'pr') {
    return {
      platform_unsupported: true,
      hint: 'use type="mr" on GitLab',
    };
  }

  try {
    const cwd = projectDir();
    const body = args.body ?? '';

    if (isIssueType(args.type)) {
      const cmd = ['glab', 'issue', 'create', '--title', args.title, '--description', body];
      const autoLabel = ISSUE_TYPE_LABELS[args.type];
      const labels = autoLabel ? [autoLabel, ...(args.labels ?? [])] : [...(args.labels ?? [])];
      if (labels.length > 0) {
        cmd.push('--label', labels.join(','));
      }
      if (args.repo !== undefined) cmd.push('-R', args.repo);

      const result = runArgv(cmd, cwd);
      if (result.exitCode !== 0) {
        return {
          ok: false,
          code: 'glab_issue_create_failed',
          error: `glab issue create failed: ${result.stderr.trim() || result.stdout.trim()}`,
        };
      }
      return { ok: true, data: parseGlabOutput(result.stdout) };
    }

    // args.type === 'mr'
    const cmd = ['glab', 'mr', 'create', '--title', args.title, '--description', body];
    if (args.head_branch !== undefined) cmd.push('--source-branch', args.head_branch);
    if (args.base_branch !== undefined) cmd.push('--target-branch', args.base_branch);
    if (args.draft) cmd.push('--draft');
    const labels = args.labels ?? [];
    if (labels.length > 0) {
      cmd.push('--label', labels.join(','));
    }
    if (args.repo !== undefined) cmd.push('-R', args.repo);

    const result = runArgv(cmd, cwd);
    if (result.exitCode !== 0) {
      return {
        ok: false,
        code: 'glab_mr_create_failed',
        error: `glab mr create failed: ${result.stderr.trim() || result.stdout.trim()}`,
      };
    }
    return { ok: true, data: parseGlabOutput(result.stdout) };
  } catch (err) {
    return {
      ok: false,
      code: 'unexpected_error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// See work-item-github.ts for the rationale.
void execSync;
