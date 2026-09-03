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
 *   Issue types (plan | epic | story | bug | chore | doc | feature | fix):
 *     glab issue create
 *       --title <title>
 *       --description <body>
 *       [--label <csv>]               // glab takes a comma-separated list; auto
 *       //                               `type::<type>` unless the caller set one
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
import { resolveGitlabSelfSync } from './resolve-gitlab-self.js';
import type {
  AdapterResult,
  WorkItemArgs,
  WorkItemResponse,
} from './types.js';

function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

const ISSUE_TYPE_LABELS: Record<string, string | null> = {
  plan: 'type::plan',
  epic: 'type::epic',
  story: 'type::story',
  feature: 'type::feature',
  bug: 'type::bug',
  chore: 'type::chore',
  doc: 'type::doc',
  fix: 'type::fix',
  pr: null,
  mr: null,
};

/**
 * The auto `type::<type>` label, UNLESS the caller already supplied one.
 *
 * The auto-label used to be prepended unconditionally. That was only ever safe by
 * ACCIDENT, and only on GitLab: `type::epic` and `type::plan` share the `type::`
 * scope key, GitLab's scoped labels are mutually exclusive, and the caller's later
 * label evicted ours. GitHub has NO scoped labels — so the same call produced an
 * issue carrying BOTH, which is precisely the taxonomy leak Dev Spec R-19 forbids
 * (a Plan is a pipeline artifact; an Epic is a PM-layer grouping the pipeline never
 * reads).
 *
 * Relying on the target platform to clean up after us is not a contract. If the
 * caller has stated the type explicitly, we do not second-guess it — on either
 * platform.
 */
function autoTypeLabel(
  type: string,
  callerLabels: string[] | undefined,
): string | null {
  const auto = ISSUE_TYPE_LABELS[type];
  if (!auto) return null;
  const callerSetType = (callerLabels ?? []).some((l) =>
    l.trim().toLowerCase().startsWith('type::'),
  );
  return callerSetType ? null : auto;
}

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
      // Normalize ONCE, then feed BOTH the suppression check and the argv. If we
      // only trim for detection, ' type::plan ' suppresses the auto-label and then
      // goes to the platform verbatim — gh matches label names exactly and rejects
      // the create, and GitLab happily mints a junk label. Handing the mess to the
      // platform after taking responsibility for it is the very thing this function
      // exists to stop.
      const callerLabels = (args.labels ?? []).map((l) => l.trim()).filter(Boolean);
      const autoLabel = autoTypeLabel(args.type, callerLabels);
      const labels = autoLabel ? [autoLabel, ...callerLabels] : callerLabels;
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
    // Self-assign at creation (#577). glab's `--assignee` takes a username (not
    // gh's `@me`), so resolve the current user first. Non-fatal — a null
    // resolution creates the MR unassigned rather than failing.
    const self = resolveGitlabSelfSync(cwd);
    if (self) cmd.push('--assignee', self);
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
