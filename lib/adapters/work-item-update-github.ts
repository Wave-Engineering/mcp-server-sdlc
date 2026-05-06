/**
 * GitHub `work_item_update` adapter implementation (#287).
 *
 * Updates an existing GitHub issue via `gh issue edit`. Supports title-only,
 * body-only, label, assignee, milestone, and section-level body patches.
 *
 * Argv composition:
 *   gh issue edit <number>
 *     [--title <new title>]
 *     [--body <new full body>]
 *     [--add-label <label>]... [--remove-label <label>]...
 *     [--add-assignee <user>]... [--remove-assignee <user>]...
 *     [--milestone <name>]
 *     [--repo <owner/repo>]
 *
 * Body-section patching:
 *   When `patch.body_section` is set, this adapter first reads the current
 *   issue body (via `gh issue view --json body`), splices in the new section
 *   content via `spliceH2Section`, and sends the resulting full body to
 *   `gh issue edit --body`. Section-level patches are mutually exclusive with
 *   `patch.body` — the handler's schema enforces that.
 *
 * Label/assignee replacement semantics:
 *   `gh issue edit` does not have a "replace all labels" flag — it only
 *   supports `--add-label` and `--remove-label`. To get replacement semantics
 *   we read the current label set, compute the (add, remove) diff, and emit
 *   the matching flags. Same shape for assignees.
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

const GITHUB_REPO_SLUG = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

interface GhIssueViewBody {
  body?: string;
  url?: string;
  number?: number;
  labels?: Array<{ name?: string }>;
  assignees?: Array<{ login?: string }>;
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
): { ok: true; data: GhIssueViewBody } | { ok: false; error: string } {
  const cmd = [
    'gh',
    'issue',
    'view',
    String(num),
    '--json',
    'number,url,body,labels,assignees',
  ];
  if (repo !== undefined) cmd.push('--repo', repo);
  const result = runArgv(cmd, cwd);
  if (result.exitCode !== 0) {
    return {
      ok: false,
      error: `gh issue view failed: ${result.stderr.trim() || result.stdout.trim()}`,
    };
  }
  try {
    const parsed = JSON.parse(result.stdout) as GhIssueViewBody;
    return { ok: true, data: parsed };
  } catch (err) {
    return {
      ok: false,
      error: `gh issue view returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
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

export async function workItemUpdateGithub(
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
  if (args.repo !== undefined && !GITHUB_REPO_SLUG.test(args.repo)) {
    return {
      ok: false,
      code: 'invalid_repo_slug',
      error: `invalid repo slug: ${args.repo}`,
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

  const cwd = projectDir();
  const updated_fields: string[] = [];
  let resolvedBody: string | undefined;
  let needCurrentLabels = patch.labels !== undefined;
  let needCurrentAssignees = patch.assignees !== undefined;
  const needCurrentBody = patch.body_section !== undefined;
  let urlFromView: string | undefined;
  let currentLabels: string[] = [];
  let currentAssignees: string[] = [];

  if (needCurrentLabels || needCurrentAssignees || needCurrentBody) {
    const fetched = fetchCurrentIssue(num, args.repo, cwd);
    if (!fetched.ok) {
      return { ok: false, code: 'gh_issue_view_failed', error: fetched.error };
    }
    urlFromView = fetched.data.url;
    currentLabels = (fetched.data.labels ?? [])
      .map((l) => (typeof l.name === 'string' ? l.name : ''))
      .filter((n) => n.length > 0);
    currentAssignees = (fetched.data.assignees ?? [])
      .map((a) => (typeof a.login === 'string' ? a.login : ''))
      .filter((n) => n.length > 0);

    if (needCurrentBody) {
      const splice = spliceH2Section(
        fetched.data.body ?? '',
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
  if (patch.milestone !== undefined) updated_fields.push('milestone');

  if (updated_fields.length === 0) {
    return {
      ok: false,
      code: 'empty_patch',
      error: 'patch must include at least one field',
    };
  }

  // Dry-run: short-circuit before running gh.
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

  // Compose `gh issue edit` argv.
  const cmd = ['gh', 'issue', 'edit', String(num)];
  if (patch.title !== undefined) cmd.push('--title', patch.title);
  if (patch.body !== undefined) cmd.push('--body', patch.body);
  else if (resolvedBody !== undefined) cmd.push('--body', resolvedBody);

  if (patch.labels !== undefined) {
    const { add, remove } = diffSets(currentLabels, patch.labels);
    for (const l of add) cmd.push('--add-label', l);
    for (const l of remove) cmd.push('--remove-label', l);
  }
  if (patch.assignees !== undefined) {
    const { add, remove } = diffSets(currentAssignees, patch.assignees);
    for (const a of add) cmd.push('--add-assignee', a);
    for (const a of remove) cmd.push('--remove-assignee', a);
  }
  if (patch.milestone !== undefined) cmd.push('--milestone', patch.milestone);
  if (args.repo !== undefined) cmd.push('--repo', args.repo);

  const result = runArgv(cmd, cwd);
  if (result.exitCode !== 0) {
    return {
      ok: false,
      code: 'gh_issue_edit_failed',
      error: `gh issue edit failed: ${result.stderr.trim() || result.stdout.trim()}`,
    };
  }

  // gh issue edit prints the issue URL on success — reuse it; otherwise fall
  // back to the URL captured during the pre-fetch.
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

// `execSync` is intentionally re-imported so adapter-level tests can
// `mock.module('child_process', ...)` and intercept this module's subprocess
// calls. See work-item-github.ts for the rationale.
void execSync;
