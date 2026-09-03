/**
 * Platform-agnostic core of `branch_create` (#579).
 *
 * Everything here is plain `git` — name validation, the dirty-tree refusal, and
 * the local checkout sequence. The per-platform adapters (branch-create-github /
 * -gitlab) resolve the default branch, self-assign the linked issue, and (GitLab)
 * flip the work-item Status; they delegate the git work to this function so the
 * two platforms can never drift on the branch mechanics.
 *
 * Name validation mirrors `handlers/ibm.ts` and `lib/wave-reconcile.ts`: the
 * accepted prefixes come from the single-source `BRANCH_PREFIXES`, and a
 * plural/unknown prefix (`docs/`, `features/`) surfaces as an unrecognized-prefix
 * error — never a silent pass or a misleading "no issue" message.
 */

import { execSync } from 'child_process';
import { runArgv } from '../shared/error-norm.js';
import { BRANCH_PREFIXES } from '../shared/branch-prefixes.js';

const PREFIX_ALT = BRANCH_PREFIXES.join('|');
const BRANCH_PATTERN = new RegExp(`^(?:${PREFIX_ALT})\\/(\\d+)-`);
const FORMAT_HINT = `(${PREFIX_ALT})/NNN-description (prefixes are singular — e.g. 'doc/' not 'docs/')`;

export interface BranchCreateCoreResult {
  branch: string;
  base: string;
  base_sha: string;
  issue_number: number;
}

export type CoreOutcome =
  | { ok: true; data: BranchCreateCoreResult }
  | { ok: false; code: string; error: string };

export function branchCreateCore(args: { branch: string; base: string; cwd: string }): CoreOutcome {
  const { branch, base, cwd } = args;

  // 1 — validate the name. Prefix first (precise message), then the issue number.
  const prefix = branch.split('/')[0];
  if (!(BRANCH_PREFIXES as readonly string[]).includes(prefix)) {
    return {
      ok: false,
      code: 'invalid_branch_prefix',
      error: `Branch '${branch}' has an unrecognized prefix '${prefix}'. Expected: ${FORMAT_HINT}`,
    };
  }
  const m = BRANCH_PATTERN.exec(branch);
  if (!m) {
    return {
      ok: false,
      code: 'invalid_branch_name',
      error: `Branch '${branch}' is missing an issue number. Expected: ${FORMAT_HINT}`,
    };
  }
  const issue_number = parseInt(m[1], 10);

  // 2 — refuse on a dirty tree; do not strand uncommitted changes across a checkout.
  const status = runArgv(['git', 'status', '--porcelain'], cwd);
  if (status.exitCode !== 0) {
    return { ok: false, code: 'git_status_failed', error: `git status failed: ${status.stderr.trim()}` };
  }
  if (status.stdout.trim().length > 0) {
    return {
      ok: false,
      code: 'dirty_working_tree',
      error: 'working tree has uncommitted changes; commit, stash, or discard them before creating a branch',
    };
  }

  // 3 — checkout base → ff-pull → checkout -b <name>. No auto-push (pr_create owns first push).
  const co = runArgv(['git', 'checkout', base], cwd);
  if (co.exitCode !== 0) {
    return { ok: false, code: 'git_checkout_base_failed', error: `git checkout ${base} failed: ${co.stderr.trim()}` };
  }
  const pull = runArgv(['git', 'pull', '--ff-only', 'origin', base], cwd);
  if (pull.exitCode !== 0) {
    return { ok: false, code: 'git_pull_failed', error: `git pull --ff-only origin ${base} failed: ${pull.stderr.trim()}` };
  }
  const cb = runArgv(['git', 'checkout', '-b', branch], cwd);
  if (cb.exitCode !== 0) {
    const dup = /already exists/i.test(cb.stderr);
    return {
      ok: false,
      code: dup ? 'branch_exists' : 'git_checkout_new_failed',
      error: `git checkout -b ${branch} failed: ${cb.stderr.trim()}`,
    };
  }
  const sha = runArgv(['git', 'rev-parse', 'HEAD'], cwd);
  const base_sha = sha.exitCode === 0 ? sha.stdout.trim() : '';

  return { ok: true, data: { branch, base, base_sha, issue_number } };
}

// `execSync` is intentionally re-imported so adapter-level test files can
// `mock.module('child_process', ...)` and intercept this module's subprocess
// calls. See resolve-gitlab-self.ts for the rationale.
void execSync;
