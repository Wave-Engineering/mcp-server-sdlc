/**
 * Self-assign the author to a PR/MR body's linked issues at creation (#578).
 *
 * Supports the journey where an agent opens a PR *without* going through the
 * branch tool (#579): the body's `Closes/Fixes/Resolves #N` refs name the issues
 * this PR will close, so the author is additively assigned to each — the same
 * ownership marker the branch tool sets earlier, applied at the latest
 * server-visible moment instead.
 *
 * CONTRACT — additive, idempotent, NON-FATAL:
 *  - ADDITIVE: never removes an existing (human) assignee. GitHub uses
 *    `--add-assignee`; GitLab uses the `+username` prefix on `--assignee`.
 *  - IDEMPOTENT: re-assigning an already-assigned author is a platform no-op on
 *    both CLIs — no pre-check needed.
 *  - NON-FATAL: the PR/MR already exists by the time this runs. A failed assign
 *    (or, on GitLab, an unresolvable current user) becomes a warning in the
 *    response, never a create failure.
 *
 * Only close-verb refs count. `see #99` / `related to #99` are NOT assigned —
 * they do not close the issue, so they are not ownership signals.
 */

import { execSync } from 'child_process';
import { runArgv } from '../shared/error-norm.js';
import { resolveGitlabSelfSync } from './resolve-gitlab-self.js';

export interface LinkedAssignResult {
  /** Issue numbers the author was assigned to (empty when none matched). */
  assigned: number[];
  /** Non-fatal warnings — one per failed assign, or a single resolve failure. */
  warnings: string[];
}

/**
 * Extract the issue numbers a body closes: the GitHub/GitLab close-verbs
 * (close/closes/closed, fix/fixes/fixed, resolve/resolves/resolved) followed by
 * `#N`, case-insensitive. Deduped, order-preserving. Non-close mentions do not
 * match.
 */
export function parseCloseRefs(body: string | undefined): number[] {
  if (!body) return [];
  const re = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi;
  const seen = new Set<number>();
  const out: number[] = [];
  for (const m of body.matchAll(re)) {
    const n = parseInt(m[1], 10);
    if (!seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

export interface SingleAssignResult {
  ok: boolean;
  /** Present only on failure. */
  warning?: string;
}

/**
 * GitHub: additively self-assign the author to ONE issue —
 * `gh issue edit <N> --add-assignee @me`. Additive + idempotent (platform-native).
 * The reusable primitive shared by the linked-issue loop (#578) and branch_create (#579).
 */
export function selfAssignIssueGithub(
  n: number,
  cwd: string,
  repo: string | undefined,
): SingleAssignResult {
  const cmd = ['gh', 'issue', 'edit', String(n), '--add-assignee', '@me'];
  if (repo !== undefined) cmd.push('--repo', repo);
  const result = runArgv(cmd, cwd);
  if (result.exitCode === 0) return { ok: true };
  return { ok: false, warning: `self-assign of issue #${n} failed: ${result.stderr.trim() || 'non-zero exit'}` };
}

/**
 * GitLab: additively self-assign the author to ONE issue —
 * `glab issue update <N> --assignee +<user>` (the `+` prefix is glab's additive
 * form). The resolved current `self` username is passed in (resolve once, assign
 * many). Shared by the linked-issue loop (#578) and branch_create (#579).
 */
export function selfAssignIssueGitlab(
  n: number,
  self: string,
  cwd: string,
  repo: string | undefined,
): SingleAssignResult {
  const cmd = ['glab', 'issue', 'update', String(n), '--assignee', `+${self}`];
  if (repo !== undefined) cmd.push('-R', repo);
  const result = runArgv(cmd, cwd);
  if (result.exitCode === 0) return { ok: true };
  return { ok: false, warning: `self-assign of issue #${n} failed: ${result.stderr.trim() || 'non-zero exit'}` };
}

/** GitHub: `gh issue edit <N> --add-assignee @me` per close-ref (additive, idempotent). */
export function selfAssignLinkedIssuesGithub(
  body: string | undefined,
  cwd: string,
  repo: string | undefined,
): LinkedAssignResult {
  const refs = parseCloseRefs(body);
  const assigned: number[] = [];
  const warnings: string[] = [];
  for (const n of refs) {
    const r = selfAssignIssueGithub(n, cwd, repo);
    if (r.ok) assigned.push(n);
    else if (r.warning) warnings.push(r.warning);
  }
  return { assigned, warnings };
}

/**
 * GitLab: `glab issue update <N> --assignee +<username>` per ref. The `+` prefix
 * is glab's additive form (adds without evicting existing assignees). Resolves
 * the current user once; a null resolution warns and assigns nothing.
 */
export function selfAssignLinkedIssuesGitlab(
  body: string | undefined,
  cwd: string,
  repo: string | undefined,
): LinkedAssignResult {
  const refs = parseCloseRefs(body);
  if (refs.length === 0) return { assigned: [], warnings: [] };

  const self = resolveGitlabSelfSync(cwd);
  if (self === null) {
    return {
      assigned: [],
      warnings: ['could not resolve current GitLab user (glab api /user); linked issues left unassigned'],
    };
  }

  const assigned: number[] = [];
  const warnings: string[] = [];
  for (const n of refs) {
    const r = selfAssignIssueGitlab(n, self, cwd, repo);
    if (r.ok) assigned.push(n);
    else if (r.warning) warnings.push(r.warning);
  }
  return { assigned, warnings };
}

/**
 * Merge a {@link LinkedAssignResult} into a response object, omitting the
 * optional fields when empty so a PR with no close-refs carries no noise.
 */
export function withLinkedAssign<T extends object>(
  data: T,
  r: LinkedAssignResult,
): T & { linked_issues_assigned?: number[]; linked_issue_assign_warnings?: string[] } {
  return {
    ...data,
    ...(r.assigned.length > 0 ? { linked_issues_assigned: r.assigned } : {}),
    ...(r.warnings.length > 0 ? { linked_issue_assign_warnings: r.warnings } : {}),
  };
}

// `execSync` is intentionally re-imported so adapter-level test files can
// `mock.module('child_process', ...)` and intercept this module's subprocess
// calls. See resolve-gitlab-self.ts for the rationale.
void execSync;
