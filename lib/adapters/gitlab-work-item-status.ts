/**
 * GitLab native work-item Status transition (#580).
 *
 * Flips a linked issue's native Status widget To do → **In progress** when
 * branch_create starts work on it (#579). GitLab's work-item Status has NO
 * `glab` porcelain — it is a GraphQL widget (`workItemUpdate { statusWidget }`).
 *
 * MECHANISM-AWARE (CLAUDE.md rule: "a status label where the mechanism is a
 * field accomplishes nothing"): we detect the native widget and NO-OP-with-
 * warning when a project lacks it — never a vestigial `status::*` label.
 *
 * COUPLING-AWARE (proven live, #580 research): writing an open-category status
 * onto a closed issue REOPENS it, and closing snaps status → Done. So we only
 * advance an un-started issue (`to_do`/`triage`); we SKIP `done`/`canceled`
 * (refusing to reopen a deliberately-closed item) and no-op when already
 * `in_progress`.
 *
 * NON-FATAL: every failure path returns a `warning` — the branch is already
 * created; a Status hiccup must never fail branch_create.
 *
 * GENERIC: the target is addressed by the conventional name "In progress"
 * (GitLab's system default), never a hardcoded per-namespace status id — so no
 * instance-specific identifiers live in this OaW codebase.
 */

import { execSync } from 'child_process';
import { runArgv } from '../shared/error-norm.js';

const IN_PROGRESS_NAME = 'In progress';

// GraphQL documents kept as module constants so the tests can assert the exact
// operation shape and the mock can match on a stable substring.
const READ_QUERY =
  'query($fp: ID!, $iid: String){ project(fullPath: $fp){ workItems(iid: $iid){ nodes{ id widgets{ ... on WorkItemWidgetStatus{ type status{ id name category } } } } } } }';
const WRITE_MUTATION =
  'mutation($id: WorkItemID!, $name: String){ workItemUpdate(input: { id: $id, statusWidget: { name: $name } }){ errors } }';

export interface StatusTransitionResult {
  /** Set only when a transition actually occurred. */
  status_transition?: { from: string; to: string };
  /** Non-fatal warning explaining why no transition happened. */
  warning?: string;
}

function resolveProjectFullPath(cwd: string, repo: string | undefined): string | null {
  if (repo !== undefined && repo.length > 0) return repo;
  // No slug given → resolve the cwd project's full path. glab resolves `:id`
  // from the cwd remote; no `--jq` (glab rejects it) — parse in-process.
  const r = runArgv(['glab', 'api', 'projects/:id'], cwd);
  if (r.exitCode !== 0 || r.stdout.trim().length === 0) return null;
  try {
    const p = JSON.parse(r.stdout) as { path_with_namespace?: unknown };
    return typeof p.path_with_namespace === 'string' && p.path_with_namespace.length > 0
      ? p.path_with_namespace
      : null;
  } catch {
    return null;
  }
}

interface ReadResult {
  workItemId: string;
  hasStatusWidget: boolean;
  name: string | null;
  category: string | null;
}

function readWorkItemStatus(
  fullPath: string,
  iid: number,
  cwd: string,
): { ok: true; data: ReadResult } | { ok: false; error: string } {
  const r = runArgv(
    ['glab', 'api', 'graphql', '-f', `query=${READ_QUERY}`, '-f', `fp=${fullPath}`, '-f', `iid=${String(iid)}`],
    cwd,
  );
  if (r.exitCode !== 0 || r.stdout.trim().length === 0) {
    return { ok: false, error: r.stderr.trim() || 'empty response' };
  }
  try {
    const parsed = JSON.parse(r.stdout) as {
      data?: {
        project?: {
          workItems?: {
            nodes?: Array<{
              id?: string;
              widgets?: Array<{ type?: string; status?: { name?: string; category?: string } | null }>;
            }>;
          } | null;
        } | null;
      };
      errors?: Array<{ message?: string }>;
    };
    // Top-level GraphQL errors (bad query, permissions) — surface them rather
    // than mislabelling as "not found" (symmetry with setInProgress).
    if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      return { ok: false, error: parsed.errors.map((e) => e.message ?? '').join('; ') || 'GraphQL error' };
    }
    const node = parsed.data?.project?.workItems?.nodes?.[0];
    if (!node || typeof node.id !== 'string') {
      return { ok: false, error: `work item iid ${iid} not found in ${fullPath}` };
    }
    const statusWidget = (node.widgets ?? []).find((w) => w.type === 'STATUS');
    if (!statusWidget || !statusWidget.status) {
      return { ok: true, data: { workItemId: node.id, hasStatusWidget: false, name: null, category: null } };
    }
    return {
      ok: true,
      data: {
        workItemId: node.id,
        hasStatusWidget: true,
        name: typeof statusWidget.status.name === 'string' ? statusWidget.status.name : null,
        category: typeof statusWidget.status.category === 'string' ? statusWidget.status.category : null,
      },
    };
  } catch (err) {
    return { ok: false, error: `invalid GraphQL response: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function setInProgress(
  workItemId: string,
  cwd: string,
): { ok: true } | { ok: false; error: string } {
  const r = runArgv(
    ['glab', 'api', 'graphql', '-f', `query=${WRITE_MUTATION}`, '-f', `id=${workItemId}`, '-f', `name=${IN_PROGRESS_NAME}`],
    cwd,
  );
  if (r.exitCode !== 0 || r.stdout.trim().length === 0) {
    return { ok: false, error: r.stderr.trim() || 'empty response' };
  }
  try {
    const parsed = JSON.parse(r.stdout) as {
      data?: { workItemUpdate?: { errors?: string[] } };
      errors?: Array<{ message?: string }>;
    };
    // Top-level GraphQL errors, or mutation-level errors[], both mean failure.
    if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      return { ok: false, error: parsed.errors.map((e) => e.message ?? '').join('; ') };
    }
    const mutErrors = parsed.data?.workItemUpdate?.errors;
    if (Array.isArray(mutErrors) && mutErrors.length > 0) {
      return { ok: false, error: mutErrors.join('; ') };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `invalid GraphQL response: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Transition the linked issue's native Status to In progress. Returns a
 * `status_transition` on success, or a `warning` on any non-fatal skip/failure.
 */
export function markWorkItemInProgressGitlab(
  issueNumber: number,
  cwd: string,
  repo: string | undefined,
): StatusTransitionResult {
  const fullPath = resolveProjectFullPath(cwd, repo);
  if (fullPath === null) {
    return { warning: 'could not resolve GitLab project path; work-item Status not transitioned' };
  }

  const read = readWorkItemStatus(fullPath, issueNumber, cwd);
  if (!read.ok) {
    return { warning: `could not read work-item Status: ${read.error}` };
  }
  if (!read.data.hasStatusWidget) {
    // Mechanism absent — no vestigial label fallback (CLAUDE.md rule).
    return {
      warning: `project does not expose the native work-item Status widget; Status not transitioned (no label fallback)`,
    };
  }

  const from = read.data.name ?? 'unknown';
  // ALLOWLIST, not blocklist (fail safe). Only an un-started item is advanced;
  // ANY other category — done, cancelled/canceled (GitLab's backend spells it
  // with two Ls), a future 6th category, or null — is skipped rather than
  // written, because writing an open-category status onto a closed item REOPENS
  // it (proven live). `.toLowerCase()` so an uppercase enum wire format can't
  // flip a skip into a dangerous write. The category values are `to_do`,
  // `triage`, `in_progress`, `done`, `cancelled` (WorkItemStatusCategoryEnum).
  const category = (read.data.category ?? '').toLowerCase();
  if (category === 'in_progress') {
    return {}; // already started — idempotent no-op, nothing to warn about.
  }
  if (category === 'to_do' || category === 'triage') {
    const write = setInProgress(read.data.workItemId, cwd);
    if (!write.ok) {
      return { warning: `failed to set work-item Status to In progress: ${write.error}` };
    }
    return { status_transition: { from, to: IN_PROGRESS_NAME } };
  }

  // done / cancelled / canceled / unknown / null → do NOT write (avoid reopening).
  return {
    warning: `issue #${issueNumber} Status is '${from}' (${category || 'unknown'}); not transitioning — only an un-started To do/Triage item is advanced, to avoid reopening a closed item`,
  };
}

// `execSync` re-imported for mock.module interception. See resolve-gitlab-self.ts.
void execSync;
