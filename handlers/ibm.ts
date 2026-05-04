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

const inputSchema = z.object({ branch: z.string().optional() });
const BRANCH_PATTERN = /^(feature|fix|chore|doc|bug|kahuna)\/(\d+)-/;
const PROTECTED_PATTERN = /^(main|release\/.+)$/;

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

    if (PROTECTED_PATTERN.test(branch)) {
      return envelope({
        ok: false,
        error: `Branch '${branch}' is protected — create a feature/fix/chore/docs branch from main.`,
      });
    }
    const match = BRANCH_PATTERN.exec(branch);
    if (!match) {
      return envelope({
        ok: false,
        error: 'Branch has no linked issue. Name format: type/NNN-description',
      });
    }

    const issueNumber = parseInt(match[2], 10);
    const adapter = getAdapter();
    const issueResult = await adapter.fetchIssue({ number: issueNumber });
    if ('platform_unsupported' in issueResult) return envelope({ ok: false, error: issueResult.hint });
    if (!issueResult.ok) return envelope({ ok: false, error: issueResult.error });
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
