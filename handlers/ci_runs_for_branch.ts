import { execSync } from 'child_process';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';

const inputSchema = z.object({
  branch: z.string().min(1, 'branch must be a non-empty string'),
  limit: z.number().int().positive().optional().default(10),
  status: z.enum(['success', 'failure', 'in_progress', 'all']).optional().default('all'),
});

type Input = z.infer<typeof inputSchema>;

interface RunRecord {
  run_id: number;
  workflow_name: string;
  status: string;
  conclusion: string | null;
  sha: string;
  url: string;
  created_at: string;
}

function detectPlatform(): 'github' | 'gitlab' {
  try {
    const url = execSync('git remote get-url origin', { encoding: 'utf8' }).trim();
    return url.includes('gitlab') ? 'gitlab' : 'github';
  } catch {
    return 'github';
  }
}

// Map the caller's normalized status filter to the flag value each CLI expects.
function githubStatusFlag(status: Input['status']): string | null {
  switch (status) {
    case 'success':
      // GitHub run list accepts conclusion values here (success/failure/...).
      return 'success';
    case 'failure':
      return 'failure';
    case 'in_progress':
      return 'in_progress';
    case 'all':
    default:
      return null;
  }
}

function gitlabStatusFlag(status: Input['status']): string | null {
  switch (status) {
    case 'success':
      return 'success';
    case 'failure':
      return 'failed';
    case 'in_progress':
      return 'running';
    case 'all':
    default:
      return null;
  }
}

interface GithubRun {
  databaseId: number;
  name: string;
  status: string;
  conclusion: string | null;
  headSha: string;
  url: string;
  createdAt: string;
}

function fetchGithubRuns(branch: string, limit: number, status: Input['status']): RunRecord[] {
  const statusFlag = githubStatusFlag(status);
  const statusArg = statusFlag ? ` --status ${statusFlag}` : '';
  const cmd =
    `gh run list --branch ${JSON.stringify(branch)} --limit ${limit}${statusArg}` +
    ` --json databaseId,name,status,conclusion,headSha,url,createdAt`;
  const raw = execSync(cmd, { encoding: 'utf8' });
  const runs = JSON.parse(raw) as GithubRun[];
  return runs.map(r => ({
    run_id: r.databaseId,
    workflow_name: r.name,
    status: r.status,
    conclusion: r.conclusion,
    sha: r.headSha,
    url: r.url,
    created_at: r.createdAt,
  }));
}

interface GitlabPipeline {
  id: number;
  name?: string;
  ref?: string;
  status: string;
  sha: string;
  web_url?: string;
  created_at: string;
  source?: string;
}

function fetchGitlabRuns(branch: string, limit: number, status: Input['status']): RunRecord[] {
  const statusFlag = gitlabStatusFlag(status);
  const statusArg = statusFlag ? ` --status ${statusFlag}` : '';
  const cmd =
    `glab ci list --branch ${JSON.stringify(branch)} --per-page ${limit}${statusArg}` +
    ` --output json`;
  const raw = execSync(cmd, { encoding: 'utf8' });
  const pipelines = JSON.parse(raw) as GitlabPipeline[];
  return pipelines.map(p => {
    // GitLab pipelines don't expose a separate status/conclusion; derive conclusion from
    // the terminal state so consumers get a consistent shape across platforms.
    const terminal = p.status === 'success' || p.status === 'failed' || p.status === 'canceled';
    return {
      run_id: p.id,
      workflow_name: p.name ?? p.source ?? 'pipeline',
      status: p.status,
      conclusion: terminal ? p.status : null,
      sha: p.sha,
      url: p.web_url ?? '',
      created_at: p.created_at,
    };
  });
}

const ciRunsForBranchHandler: HandlerDef = {
  name: 'ci_runs_for_branch',
  description:
    'List recent workflow/pipeline runs for a branch, newest first. Supports GitHub (gh run) and GitLab (glab ci).',
  inputSchema,
  async execute(rawArgs: unknown) {
    let args: Input;
    try {
      args = inputSchema.parse(rawArgs);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error }) }],
      };
    }

    try {
      const platform = detectPlatform();
      const runs =
        platform === 'github'
          ? fetchGithubRuns(args.branch, args.limit, args.status)
          : fetchGitlabRuns(args.branch, args.limit, args.status);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ ok: true, runs }),
          },
        ],
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error }) }],
      };
    }
  },
};

export default ciRunsForBranchHandler;
