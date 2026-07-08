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

const inputSchema = z.object({ branch: z.string().optional() });

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
  return execSync('git branch --show-current', { encoding: 'utf8' }).trim();
}

const ibmHandler: HandlerDef = {
  name: 'ibm',
  description:
    'Check Issue → Branch → PR/MR workflow compliance. Verifies the current branch is linked to an open issue and reports any existing PR/MR.',
  inputSchema,
  async execute(rawArgs: unknown) {
    const args = inputSchema.parse(rawArgs);
    const branch = args.branch ?? getCurrentBranch();

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
    const adapter = getAdapter();
    const issueResult = await adapter.fetchIssue({ number: issueNumber });
    if ('platform_unsupported' in issueResult) return envelope({ ok: false, error: issueResult.hint });
    // Well-formed branch, but the referenced issue could not be read (missing,
    // not linked, or a transient lookup failure). Name the parsed number so the
    // caller knows which issue and that the branch format was accepted.
    if (!issueResult.ok) {
      return envelope({
        ok: false,
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

    const prResult = await adapter.fetchPrForBranch({ branch });
    if ('platform_unsupported' in prResult) return envelope({ ok: false, error: prResult.hint });
    if (!prResult.ok) return envelope({ ok: false, error: prResult.error });

    return envelope({
      ok: true,
      issue_number: issueNumber,
      issue_title: issue.title,
      issue_url: issue.url,
      branch,
      pr_url: prResult.data ? prResult.data.url : null,
      message: `In order: issue #${issueNumber} is open, branch is correctly linked`,
    });
  },
};

export default ibmHandler;
