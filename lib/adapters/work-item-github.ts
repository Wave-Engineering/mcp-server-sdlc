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
 *   Issue types (plan | epic | story | bug | chore | doc | feature | fix):
 *     gh issue create
 *       --title <title>
 *       --body <body>
 *       [--label <label>]...          // auto `type::<type>` UNLESS the caller
 *       //                               supplied a type::* label of their own
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
import { selfAssignLinkedIssuesGithub, withLinkedAssign } from './self-assign-linked-issues.js';
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
      // Normalize ONCE, then feed BOTH the suppression check and the argv. If we
      // only trim for detection, ' type::plan ' suppresses the auto-label and then
      // goes to the platform verbatim — gh matches label names exactly and rejects
      // the create, and GitLab happily mints a junk label. Handing the mess to the
      // platform after taking responsibility for it is the very thing this function
      // exists to stop.
      const callerLabels = (args.labels ?? []).map((l) => l.trim()).filter(Boolean);
      const autoLabel = autoTypeLabel(args.type, callerLabels);
      const labels = autoLabel ? [autoLabel, ...callerLabels] : callerLabels;
      for (const label of labels) {
        cmd.push('--label', label);
      }
      if (args.repo !== undefined) cmd.push('--repo', args.repo);

      const result = runArgv(cmd, cwd);
      if (result.exitCode !== 0) {
        const stderr = result.stderr.trim() || result.stdout.trim();
        // `gh issue create --label X` FAILS (and creates nothing) when X does not
        // already exist on the repo — unlike GitLab, which mints labels implicitly.
        // Carry the remedy in the server rather than relying on every skill to
        // remember it.
        const missingLabel = /could not add label/i.test(stderr)
          ? ` — the label must already exist on the repo: call label_create for it first (GitHub does not create labels implicitly; GitLab does)`
          : '';
        return {
          ok: false,
          code: 'gh_issue_create_failed',
          error: `gh issue create failed: ${stderr}${missingLabel}`,
        };
      }
      return { ok: true, data: parseGhOutput(result.stdout) };
    }

    // args.type === 'pr'
    // Self-assign at creation (#577) — `@me` is server-resolved by gh; the author
    // is always assignable to their own PR, so this cannot fail the create.
    const cmd = ['gh', 'pr', 'create', '--title', args.title, '--body', body, '--assignee', '@me'];
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
    // Additively self-assign the author to the issues this PR closes (#578).
    const linked = selfAssignLinkedIssuesGithub(body, cwd, args.repo);
    return { ok: true, data: withLinkedAssign(parseGhOutput(result.stdout), linked) };
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
