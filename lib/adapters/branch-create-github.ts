/**
 * GitHub `branchCreate` adapter (#579).
 *
 * Resolves the default branch when no base is given, runs the platform-agnostic
 * git core (branch-create-core.ts), then additively self-assigns the linked
 * issue via the shared `selfAssignIssueGithub` primitive (#578). GitHub issues
 * have no native Status field, so there is no status transition here — the
 * branch-time marker on GitHub is exactly the self-assign.
 */

import { execSync } from 'child_process';
import { resolveDefaultBranchGithubSync } from './resolve-default-branch-github.js';
import { selfAssignIssueGithub } from './self-assign-linked-issues.js';
import { branchCreateCore } from './branch-create-core.js';
import type { AdapterResult, BranchCreateArgs, BranchCreateResponse } from './types.js';

function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

export async function branchCreateGithub(
  args: BranchCreateArgs,
): Promise<AdapterResult<BranchCreateResponse>> {
  try {
    const cwd = args.cwd ?? projectDir();

    let base = args.base;
    if (base === undefined || base.length === 0) {
      try {
        base = resolveDefaultBranchGithubSync(args.repo, cwd);
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
    const assign = selfAssignIssueGithub(core.data.issue_number, cwd, args.repo);
    if (!assign.ok && assign.warning) warnings.push(assign.warning);

    return {
      ok: true,
      data: {
        branch: core.data.branch,
        base: core.data.base,
        base_sha: core.data.base_sha,
        issue_number: core.data.issue_number,
        ...(assign.ok ? { issue_assigned: core.data.issue_number } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
      },
    };
  } catch (err) {
    return { ok: false, code: 'unexpected_error', error: err instanceof Error ? err.message : String(err) };
  }
}

// `execSync` re-imported for mock.module interception. See resolve-gitlab-self.ts.
void execSync;
