/**
 * GitLab `branchCreate` adapter (#579).
 *
 * Resolves the default branch when no base is given, runs the platform-agnostic
 * git core (branch-create-core.ts), then additively self-assigns the linked
 * issue: resolve the current user once via `resolveGitlabSelfSync`, then
 * `selfAssignIssueGitlab` (the `+username` additive form, #578).
 *
 * The GitLab-only work-item Status flip (To do → In Progress) is DEFERRED to
 * #580 — see the TODO below. The branch is created regardless; #580 wires the
 * GraphQL mutation into this same seam.
 */

import { execSync } from 'child_process';
import { resolveDefaultBranchGitlabSync } from './resolve-default-branch-gitlab.js';
import { resolveGitlabSelfSync } from './resolve-gitlab-self.js';
import { selfAssignIssueGitlab } from './self-assign-linked-issues.js';
import { markWorkItemInProgressGitlab } from './gitlab-work-item-status.js';
import { branchCreateCore } from './branch-create-core.js';
import type { AdapterResult, BranchCreateArgs, BranchCreateResponse } from './types.js';

function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

export async function branchCreateGitlab(
  args: BranchCreateArgs,
): Promise<AdapterResult<BranchCreateResponse>> {
  try {
    const cwd = args.cwd ?? projectDir();

    let base = args.base;
    if (base === undefined || base.length === 0) {
      try {
        base = resolveDefaultBranchGitlabSync(args.repo, cwd);
      } catch (err) {
        return {
          ok: false,
          code: 'default_branch_resolve_failed',
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    const core = branchCreateCore({ branch: args.branch, base, cwd });
    if (!core.ok) return core;

    const warnings: string[] = [];
    let issue_assigned: number | undefined;
    const self = resolveGitlabSelfSync(cwd);
    if (self === null) {
      warnings.push('could not resolve current GitLab user (glab api /user); linked issue left unassigned');
    } else {
      const assign = selfAssignIssueGitlab(core.data.issue_number, self, cwd, args.repo);
      if (assign.ok) issue_assigned = core.data.issue_number;
      else if (assign.warning) warnings.push(assign.warning);
    }

    // Flip the linked work item's native Status To do → In progress (#580).
    // Mechanism-aware + coupling-aware + non-fatal — see gitlab-work-item-status.ts.
    const status = markWorkItemInProgressGitlab(core.data.issue_number, cwd, args.repo);
    if (status.warning) warnings.push(status.warning);

    return {
      ok: true,
      data: {
        branch: core.data.branch,
        base: core.data.base,
        base_sha: core.data.base_sha,
        issue_number: core.data.issue_number,
        ...(issue_assigned !== undefined ? { issue_assigned } : {}),
        ...(status.status_transition ? { status_transition: status.status_transition } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
      },
    };
  } catch (err) {
    return { ok: false, code: 'unexpected_error', error: err instanceof Error ? err.message : String(err) };
  }
}

// `execSync` re-imported for mock.module interception. See resolve-gitlab-self.ts.
void execSync;
