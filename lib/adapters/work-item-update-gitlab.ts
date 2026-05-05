/**
 * GitLab `work_item_update` adapter implementation (#287).
 *
 * Updates an existing GitLab issue via `glab issue update`. Supports
 * title-only, body-only, label, assignee, and section-level body patches.
 *
 * Argv composition (per `lesson_origin_ops_pitfalls.md` — glab uses `-R`,
 * `--description`, comma-separated labels, NOT GitHub-style flags):
 *
 *   glab issue update <number>
 *     [--title <new title>]
 *     [--description <new full body>]
 *     [--label <added,csv>]
 *     [--unlabel <removed,csv>]
 *     [--assignee <added,csv>]
 *     [--unassign <removed,csv>]
 *     [-R <owner/repo>]
 *
 * Cross-platform asymmetry (R-03 / #281):
 *   - `patch.milestone` returns `platform_unsupported`. GitLab does have
 *     milestones, but `glab issue update --milestone` requires a milestone
 *     *id* and group/project resolution that this thin tool does not own.
 *     Callers that need GitLab milestone updates should call `glab` directly.
 *
 * Body-section patching:
 *   When `patch.body_section` is set, this adapter first reads the current
 *   issue body (via `glab issue view -F json`), splices in the new section
 *   content via `spliceH2Section`, and sends the resulting full body to
 *   `glab issue update --description`.
 *
 * Label/assignee replacement semantics:
 *   `glab issue update` accepts `--label` (additive csv) and `--unlabel`
 *   (csv to remove). To get replacement semantics we read the current label
 *   set, compute the (add, remove) diff, and emit the matching flags. Same
 *   shape for assignees (`--assignee` / `--unassign`).
 */

import { execSync } from 'child_process';
import { runArgv } from '../shared/error-norm.js';
import { spliceH2Section } from '../work-item-section.js';
import type {
  AdapterResult,
  WorkItemUpdateArgs,
  WorkItemUpdateResponse,
} from './types.js';

function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

interface GlabIssueViewBody {
  iid?: number;
  description?: string;
  web_url?: string;
  labels?: string[];
  assignees?: Array<{ username?: string }>;
}

function parseIssueRefNumber(ref: string): number | null {
  const full = /^(.+)\/([^/\s#]+)#(\d+)$/.exec(ref);
  if (full) return parseInt(full[3], 10);
  const short = /^#?(\d+)$/.exec(ref);
  if (short) return parseInt(short[1], 10);
  return null;
}

function fetchCurrentIssue(
  num: number,
  repo: string | undefined,
  cwd: string,
): { ok: true; data: GlabIssueViewBody } | { ok: false; error: string } {
  const cmd = ['glab', 'issue', 'view', String(num), '-F', 'json'];
  if (repo !== undefined) cmd.push('-R', repo);
  const result = runArgv(cmd, cwd);
  if (result.exitCode !== 0) {
    return {
      ok: false,
      error: `glab issue view failed: ${result.stderr.trim() || result.stdout.trim()}`,
    };
  }
  try {
    const parsed = JSON.parse(result.stdout) as GlabIssueViewBody;
    return { ok: true, data: parsed };
  } catch (err) {
    return {
      ok: false,
      error: `glab issue view returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function diffSets(current: string[], next: string[]): { add: string[]; remove: string[] } {
  const cur = new Set(current);
  const nxt = new Set(next);
  const add: string[] = [];
  const remove: string[] = [];
  for (const v of nxt) if (!cur.has(v)) add.push(v);
  for (const v of cur) if (!nxt.has(v)) remove.push(v);
  return { add, remove };
}

export async function workItemUpdateGitlab(
  args: WorkItemUpdateArgs,
): Promise<AdapterResult<WorkItemUpdateResponse>> {
  const num = parseIssueRefNumber(args.issue_ref);
  if (num === null) {
    return {
      ok: false,
      code: 'invalid_issue_ref',
      error: `cannot parse issue_ref: ${args.issue_ref}`,
    };
  }

  const patch = args.patch;
  if (patch.body !== undefined && patch.body_section !== undefined) {
    return {
      ok: false,
      code: 'patch_conflict',
      error: 'patch.body and patch.body_section are mutually exclusive',
    };
  }
  if (patch.milestone !== undefined) {
    return {
      platform_unsupported: true,
      hint: 'milestone updates not supported via work_item_update on GitLab; call glab directly with the numeric milestone id',
    };
  }

  const cwd = projectDir();
  const updated_fields: string[] = [];
  let resolvedBody: string | undefined;
  const needCurrentLabels = patch.labels !== undefined;
  const needCurrentAssignees = patch.assignees !== undefined;
  const needCurrentBody = patch.body_section !== undefined;
  let urlFromView: string | undefined;
  let currentLabels: string[] = [];
  let currentAssignees: string[] = [];

  if (needCurrentLabels || needCurrentAssignees || needCurrentBody) {
    const fetched = fetchCurrentIssue(num, args.repo, cwd);
    if (!fetched.ok) {
      return { ok: false, code: 'glab_issue_view_failed', error: fetched.error };
    }
    urlFromView = fetched.data.web_url;
    currentLabels = Array.isArray(fetched.data.labels)
      ? fetched.data.labels.filter((s): s is string => typeof s === 'string')
      : [];
    currentAssignees = (fetched.data.assignees ?? [])
      .map((a) => (typeof a.username === 'string' ? a.username : ''))
      .filter((n) => n.length > 0);

    if (needCurrentBody) {
      const splice = spliceH2Section(
        fetched.data.description ?? '',
        patch.body_section!.heading,
        patch.body_section!.content,
      );
      if (!splice.ok) {
        return { ok: false, code: 'section_splice_failed', error: splice.error };
      }
      resolvedBody = splice.body;
    }
  }

  if (patch.title !== undefined) updated_fields.push('title');
  if (patch.body !== undefined) updated_fields.push('body');
  if (patch.body_section !== undefined) updated_fields.push('body_section');
  if (patch.labels !== undefined) updated_fields.push('labels');
  if (patch.assignees !== undefined) updated_fields.push('assignees');

  if (updated_fields.length === 0) {
    return {
      ok: false,
      code: 'empty_patch',
      error: 'patch must include at least one field',
    };
  }

  if (args.dry_run) {
    return {
      ok: true,
      data: {
        url: urlFromView ?? '',
        number: num,
        dry_run: true,
        updated_fields,
        ...(resolvedBody !== undefined ? { resolved_body: resolvedBody } : {}),
      },
    };
  }

  const cmd = ['glab', 'issue', 'update', String(num)];
  if (patch.title !== undefined) cmd.push('--title', patch.title);
  if (patch.body !== undefined) cmd.push('--description', patch.body);
  else if (resolvedBody !== undefined) cmd.push('--description', resolvedBody);

  if (patch.labels !== undefined) {
    const { add, remove } = diffSets(currentLabels, patch.labels);
    if (add.length > 0) cmd.push('--label', add.join(','));
    if (remove.length > 0) cmd.push('--unlabel', remove.join(','));
  }
  if (patch.assignees !== undefined) {
    const { add, remove } = diffSets(currentAssignees, patch.assignees);
    if (add.length > 0) cmd.push('--assignee', add.join(','));
    if (remove.length > 0) cmd.push('--unassign', remove.join(','));
  }
  if (args.repo !== undefined) cmd.push('-R', args.repo);

  const result = runArgv(cmd, cwd);
  if (result.exitCode !== 0) {
    return {
      ok: false,
      code: 'glab_issue_update_failed',
      error: `glab issue update failed: ${result.stderr.trim() || result.stdout.trim()}`,
    };
  }

  const url = result.stdout.trim().split('\n').pop()?.trim() || urlFromView || '';

  return {
    ok: true,
    data: {
      url,
      number: num,
      dry_run: false,
      updated_fields,
      ...(resolvedBody !== undefined ? { resolved_body: resolvedBody } : {}),
    },
  };
}

// See work-item-gitlab.ts for the rationale on this `void`.
void execSync;
