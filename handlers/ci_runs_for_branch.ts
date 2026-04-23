// Origin Operations family handler.
// See docs/handlers/origin-operations-guide.md for the canonical pattern,
// gh ↔ glab field mappings, and normalized response schemas.

import { execSync } from 'child_process';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { detectPlatform, gitlabApiCiList } from '../lib/glab.js';

const inputSchema = z.object({
  branch: z.string().min(1, 'branch must be a non-empty string'),
  limit: z.number().int().positive().optional().default(10),
  status: z.enum(['success', 'failure', 'in_progress', 'all']).optional().default('all'),
  repo: z
    .string()
    .regex(/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/, 'repo must be in owner/repo form')
    .optional(),
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

function fetchGithubRuns(
  branch: string,
  limit: number,
  status: Input['status'],
  repo: string | undefined,
): RunRecord[] {
  const statusFlag = githubStatusFlag(status);
  const statusArg = statusFlag ? ` --status ${statusFlag}` : '';
  const repoArg = repo ? ` --repo ${repo}` : '';
  const cmd =
    `gh run list --branch ${JSON.stringify(branch)} --limit ${limit}${statusArg}${repoArg}` +
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

function splitRepoSlug(
  repo: string | undefined,
): { owner: string; repo: string } | undefined {
  if (!repo) return undefined;
  const [owner, name] = repo.split('/', 2);
  return { owner, repo: name };
}

function fetchGitlabRuns(
  branch: string,
  limit: number,
  status: Input['status'],
  repo: string | undefined,
): RunRecord[] {
  // GitLab API doesn't support status filtering, so we fetch more and filter client-side.
  const fetchLimit = status === 'all' ? limit : limit * 3;
  const pipelines = gitlabApiCiList({ ref: branch, limit: fetchLimit }, splitRepoSlug(repo));

  const targetStatus = gitlabStatusFlag(status);
  const filtered = targetStatus
    ? pipelines.filter(p => p.status === targetStatus)
    : pipelines;

  const results = filtered.slice(0, limit).map(p => {
    // GitLab pipelines don't expose a separate status/conclusion; derive conclusion from
    // the terminal state so consumers get a consistent shape across platforms.
    const terminal = p.status === 'success' || p.status === 'failed' || p.status === 'canceled';
    return {
      run_id: p.id,
      workflow_name: p.source ?? 'pipeline',
      status: p.status,
      conclusion: terminal ? p.status : null,
      sha: p.sha,
      url: p.web_url,
      created_at: p.created_at ?? '',
    };
  });

  return results;
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
          ? fetchGithubRuns(args.branch, args.limit, args.status, args.repo)
          : fetchGitlabRuns(args.branch, args.limit, args.status, args.repo);

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
