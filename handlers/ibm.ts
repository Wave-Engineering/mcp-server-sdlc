import { execSync } from 'child_process';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';

const inputSchema = z.object({
  branch: z.string().optional(),
});

type Input = z.infer<typeof inputSchema>;

const BRANCH_PATTERN = /^(feature|fix|chore|docs)\/(\d+)-/;
const PROTECTED_PATTERN = /^(main|release\/.+)$/;

function exec(cmd: string): string {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

function getCurrentBranch(): string {
  return exec('git branch --show-current');
}

function detectPlatform(): 'github' | 'gitlab' {
  try {
    const url = exec('git remote get-url origin');
    return url.includes('github') ? 'github' : 'gitlab';
  } catch {
    return 'github';
  }
}

interface IssueInfo {
  state: string;
  title: string;
  url: string;
}

function getGithubIssue(issueNumber: number): IssueInfo {
  const raw = exec(`gh issue view ${issueNumber} --json state,title,url`);
  const parsed = JSON.parse(raw) as { state: string; title: string; url: string };
  return { state: parsed.state.toUpperCase(), title: parsed.title, url: parsed.url };
}

function getGitlabIssue(issueNumber: number): IssueInfo {
  const raw = exec(`glab issue view ${issueNumber} --output json`);
  const parsed = JSON.parse(raw) as { state: string; title: string; web_url: string };
  // GitLab uses 'opened'/'closed', normalize to 'OPEN'/'CLOSED'
  const state = parsed.state === 'opened' ? 'OPEN' : parsed.state.toUpperCase();
  return {
    state,
    title: parsed.title,
    url: parsed.web_url,
  };
}

function getGithubPrUrl(branch: string): string | null {
  try {
    const raw = exec(`gh pr list --head "${branch}" --json number,url`);
    const prs = JSON.parse(raw) as Array<{ number: number; url: string }>;
    return prs.length > 0 ? prs[0].url : null;
  } catch {
    return null;
  }
}

function getGitlabMrUrl(branch: string): string | null {
  try {
    const raw = exec(`glab mr list --source-branch "${branch}" --output json`);
    const mrs = JSON.parse(raw) as Array<{ web_url?: string; iid?: number }>;
    return mrs.length > 0 ? (mrs[0].web_url ?? null) : null;
  } catch {
    return null;
  }
}

const ibmHandler: HandlerDef = {
  name: 'ibm',
  description:
    'Check Issue → Branch → PR/MR workflow compliance. Verifies the current branch is linked to an open issue and reports any existing PR/MR.',
  inputSchema,
  async execute(rawArgs: unknown) {
    const args = inputSchema.parse(rawArgs) as Input;

    const branch = args.branch ?? getCurrentBranch();

    // Protected branch check
    if (PROTECTED_PATTERN.test(branch)) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: `Branch '${branch}' is protected — create a feature/fix/chore/docs branch from main.`,
            }),
          },
        ],
      };
    }

    // Parse issue number from branch name
    const match = BRANCH_PATTERN.exec(branch);
    if (!match) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'Branch has no linked issue. Name format: type/NNN-description',
            }),
          },
        ],
      };
    }

    const issueNumber = parseInt(match[2], 10);
    const platform = detectPlatform();

    try {
      const issue =
        platform === 'github'
          ? getGithubIssue(issueNumber)
          : getGitlabIssue(issueNumber);

      const prUrl =
        platform === 'github'
          ? getGithubPrUrl(branch)
          : getGitlabMrUrl(branch);

      if (issue.state !== 'OPEN') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: true,
                warning: `Issue #${issueNumber} is closed — reopen or create a new one`,
                issue_number: issueNumber,
                branch,
              }),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              issue_number: issueNumber,
              issue_title: issue.title,
              issue_url: issue.url,
              branch,
              pr_url: prUrl,
              message: `In order: issue #${issueNumber} is open, branch is correctly linked`,
            }),
          },
        ],
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ ok: false, error }),
          },
        ],
      };
    }
  },
};

export default ibmHandler;
