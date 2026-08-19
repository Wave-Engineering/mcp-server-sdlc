// Issue → Branch → PR/MR workflow handler — adapter-dispatching shell.
// Platform-specific subprocess work lives in
// lib/adapters/fetch-issue-{github,gitlab}.ts (fetchIssue) and
// lib/adapters/fetch-pr-for-branch-{github,gitlab}.ts (fetchPrForBranch).
// Branch-name parsing and protected-branch check stay here — platform
// agnostic. See Story 2.18 (#312).

import { execSync } from 'child_process';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { getAdapter } from '../lib/adapters/index.js';
import { PROTECTED_BRANCH_PATTERN } from '../lib/shared/protected-branch.js';
import { repoOptionalSchema } from '../lib/schemas/repo.js';

const inputSchema = z.object({
  branch: z.string().optional(),
  /**
   * Target repo (`owner/name`). Pass it whenever the branch is NOT the one checked
   * out in the server's cwd — otherwise the lookup silently resolves against the
   * cwd's repo and can match a same-numbered but UNRELATED issue (#475).
   */
  repo: repoOptionalSchema,
});

// Single source of truth for the allowed branch prefixes — the regex and the
// error message are both derived from this list so they can never drift apart.
// Prefixes are SINGULAR (the prefix names the topic, not the file type):
// `doc/` not `docs/`. A plural/unknown prefix is the most common mistake (#448),
// and it must report as an unrecognized-prefix error, NOT "no linked issue" —
// the regex fails before any issue lookup runs, so the issue/work-item framework
// is never involved.
const BRANCH_PREFIXES = ['feature', 'fix', 'chore', 'doc', 'bug', 'kahuna'] as const;
const BRANCH_PATTERN = new RegExp(`^(${BRANCH_PREFIXES.join('|')})\\/(\\d+)-`);
const BRANCH_FORMAT_HINT = `(${BRANCH_PREFIXES.join('|')})/NNN-description (prefixes are singular — e.g. 'doc/' not 'docs/')`;

function envelope(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

function getCurrentBranch(): string {
  // Tolerate failure: detached HEAD, or a server cwd that is not a git repo, both
  // yield ''. The caller's guard treats an unknown current branch as "cannot prove
  // this branch belongs to the cwd's repo" and refuses rather than guessing (#475).
  try {
    return execSync('git branch --show-current', { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

const ibmHandler: HandlerDef = {
  name: 'ibm',
  description:
    "Check Issue → Branch → PR/MR workflow compliance. Verifies the branch is linked to an open issue and reports any existing PR/MR. Repo resolution defaults to the server's working directory — pass `repo` whenever the branch is NOT the one checked out there, or the lookup can match a same-numbered but unrelated issue in the wrong repository (it now refuses rather than guessing).",
  inputSchema,
  async execute(rawArgs: unknown) {
    const args = inputSchema.parse(rawArgs);
    const currentBranch = getCurrentBranch();
    const branch = args.branch ?? currentBranch;

    // FAIL CLOSED on the cross-repo trap (#475).
    //
    // Every lookup below resolves the repo from the SERVER'S CWD unless `repo` is
    // given. So a caller working in a different repo — passing a branch that is
    // not checked out here — used to have the issue number parsed out of that
    // branch and looked up in the CWD's repo. A same-numbered but entirely
    // unrelated issue would match, and `ibm` would confidently report
    // "branch is correctly linked". That is a FALSE PASS on the first gate of
    // /precheck, which is a MANDATORY compliance check.
    //
    // If the branch isn't the one we're standing on and we weren't told which repo
    // it belongs to, we cannot know. Refuse rather than guess.
    if (args.repo === undefined && args.branch !== undefined && args.branch !== currentBranch) {
      return envelope({
        ok: false,
        error:
          `Branch '${args.branch}' is not the branch checked out here (that is '${currentBranch || 'none'}'), ` +
          `and no 'repo' was given — so there is no way to know which repository this branch belongs to. ` +
          `Refusing to guess: resolving against the current directory could match a same-numbered but ` +
          `UNRELATED issue and report a false pass. Pass repo='owner/name' explicitly.`,
      });
    }
    // The other axis of the same trap: a repo was named but NO branch. Defaulting
    // the branch from the cwd and then checking it against a DIFFERENT repo pairs a
    // branch with a repository it does not belong to — the cwd branch's issue number
    // looked up in `repo`, where a same-numbered unrelated issue would falsely pass.
    // If you name the repo, name the branch; do not let us infer one from the cwd.
    if (args.repo !== undefined && args.branch === undefined) {
      return envelope({
        ok: false,
        error:
          `A 'repo' (${args.repo}) was given but no 'branch'. Refusing to check this directory's current ` +
          `branch ('${currentBranch || 'none'}') against a different repository — the branch may not belong ` +
          `to it, and a same-numbered issue there would report a false pass. Pass the branch explicitly.`,
      });
    }

    if (PROTECTED_BRANCH_PATTERN.test(branch)) {
      return envelope({
        ok: false,
        error: `Branch '${branch}' is protected — create a branch from main named ${BRANCH_FORMAT_HINT}`,
      });
    }
    const match = BRANCH_PATTERN.exec(branch);
    if (!match) {
      // Unrecognized prefix or missing issue number — the branch name itself is
      // malformed. This is NOT an issue-linkage failure: no issue lookup runs.
      // Naming the expected format (and the singular-prefix rule) here avoids
      // misdirecting the caller toward a non-existent issue/work-item problem.
      return envelope({
        ok: false,
        error: `Branch '${branch}' has an unrecognized prefix or missing issue number. Expected: ${BRANCH_FORMAT_HINT}`,
      });
    }

    const issueNumber = parseInt(match[2], 10);
    const adapter = getAdapter({ repo: args.repo });
    const issueResult = await adapter.fetchIssue({ number: issueNumber, repo: args.repo });
    if ('platform_unsupported' in issueResult) return envelope({ ok: false, error: issueResult.hint });
    // Well-formed branch, but the referenced issue could not be read (missing,
    // not linked, or a transient lookup failure). Name the parsed number so the
    // caller knows which issue and that the branch format was accepted.
    if (!issueResult.ok) {
      return envelope({
        ok: false,
        code: issueResult.code,
        error: `Branch '${branch}' references issue #${issueNumber}, but the lookup failed: ${issueResult.error}`,
      });
    }
    const issue = issueResult.data;

    if (issue.state !== 'OPEN') {
      return envelope({
        ok: true,
        warning: `Issue #${issueNumber} is closed — reopen or create a new one`,
        issue_number: issueNumber,
        branch,
      });
    }

    const prResult = await adapter.fetchPrForBranch({ branch, repo: args.repo });
    if ('platform_unsupported' in prResult) return envelope({ ok: false, error: prResult.hint });
    if (!prResult.ok) return envelope({ ok: false, code: prResult.code, error: prResult.error });

    return envelope({
      ok: true,
      issue_number: issueNumber,
      issue_title: issue.title,
      issue_url: issue.url,
      branch,
      // Echo the repo actually checked. A caller can then SEE which repository the
      // verdict applies to instead of assuming it was theirs (#475).
      repo: args.repo ?? null,
      pr_url: prResult.data ? prResult.data.url : null,
      message: `In order: issue #${issueNumber} is open, branch is correctly linked`,
    });
  },
};

export default ibmHandler;
