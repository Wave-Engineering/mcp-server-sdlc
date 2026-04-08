import { execSync } from 'child_process';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';

const inputSchema = z
  .object({
    ref: z.string().min(1, 'ref must be a non-empty string'),
    workflow_name: z.string().optional(),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

const SHA_PATTERN = /^[0-9a-f]{40}$/i;

function exec(cmd: string): string {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

function detectPlatform(): 'github' | 'gitlab' {
  try {
    const url = exec('git remote get-url origin');
    return url.includes('github') ? 'github' : 'gitlab';
  } catch {
    return 'github';
  }
}

function isSha(ref: string): boolean {
  return SHA_PATTERN.test(ref);
}

function shellQuote(value: string): string {
  // Conservative: reject characters that could break shell quoting.
  if (!/^[A-Za-z0-9._\/-]+$/.test(value)) {
    throw new Error(`invalid characters in argument: ${value}`);
  }
  return `"${value}"`;
}

interface NormalizedRun {
  run_id: number;
  workflow_name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion:
    | 'success'
    | 'failure'
    | 'cancelled'
    | 'skipped'
    | 'timed_out'
    | null;
  url: string;
  ref: string;
  sha: string;
  created_at: string;
  finished_at: string | null;
}

interface GhRun {
  databaseId: number;
  name: string;
  status: string;
  conclusion: string | null;
  url: string;
  headBranch: string;
  headSha: string;
  createdAt: string;
  updatedAt: string;
}

interface GlRun {
  id: number;
  status: string;
  web_url: string;
  ref: string;
  sha: string;
  created_at: string;
  updated_at: string;
  finished_at?: string | null;
  name?: string | null;
  // glab sometimes exposes source/name in different forms across versions.
  source?: string | null;
}

function normalizeGhStatus(status: string): 'queued' | 'in_progress' | 'completed' {
  switch (status) {
    case 'queued':
    case 'waiting':
    case 'pending':
    case 'requested':
      return 'queued';
    case 'in_progress':
    case 'running':
      return 'in_progress';
    case 'completed':
    default:
      return 'completed';
  }
}

function normalizeGhConclusion(
  value: string | null
):
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'skipped'
  | 'timed_out'
  | null {
  if (!value) return null;
  switch (value) {
    case 'success':
    case 'failure':
    case 'cancelled':
    case 'skipped':
    case 'timed_out':
      return value;
    case 'neutral':
    case 'action_required':
    case 'stale':
      return 'failure';
    default:
      return null;
  }
}

function normalizeGlStatus(
  status: string
): 'queued' | 'in_progress' | 'completed' {
  switch (status) {
    case 'created':
    case 'waiting_for_resource':
    case 'preparing':
    case 'pending':
    case 'scheduled':
    case 'manual':
      return 'queued';
    case 'running':
      return 'in_progress';
    case 'success':
    case 'failed':
    case 'canceled':
    case 'cancelled':
    case 'skipped':
      return 'completed';
    default:
      return 'completed';
  }
}

function normalizeGlConclusion(
  status: string
):
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'skipped'
  | 'timed_out'
  | null {
  switch (status) {
    case 'success':
      return 'success';
    case 'failed':
      return 'failure';
    case 'canceled':
    case 'cancelled':
      return 'cancelled';
    case 'skipped':
      return 'skipped';
    default:
      return null;
  }
}

function ghQueryRuns(
  ref: string,
  workflowName: string | undefined
): GhRun[] {
  const selector = isSha(ref)
    ? `--commit ${shellQuote(ref)}`
    : `--branch ${shellQuote(ref)}`;
  const workflow = workflowName ? ` --workflow ${shellQuote(workflowName)}` : '';
  const cmd = `gh run list ${selector}${workflow} --limit 1 --json databaseId,name,status,conclusion,url,headBranch,headSha,createdAt,updatedAt`;
  const raw = exec(cmd);
  if (!raw) return [];
  return JSON.parse(raw) as GhRun[];
}

function glQueryRuns(
  ref: string,
  workflowName: string | undefined
): GlRun[] {
  // GitLab pipelines don't carry a workflow "name" the way GitHub does; we
  // list without filter and then apply workflow_name client-side against the
  // "name"/"source" fields for best-effort matching.
  const selector = isSha(ref)
    ? `--sha ${shellQuote(ref)}`
    : `--branch ${shellQuote(ref)}`;
  const pageSize = workflowName ? '20' : '1';
  const cmd = `glab ci list ${selector} --per-page ${pageSize} --output json`;
  const raw = exec(cmd);
  if (!raw) return [];
  const runs = JSON.parse(raw) as GlRun[];
  if (!workflowName) return runs;
  return runs.filter((r) => {
    const name = r.name ?? r.source ?? '';
    return name === workflowName;
  });
}

function normalizeGh(run: GhRun): NormalizedRun {
  const status = normalizeGhStatus(run.status);
  const conclusion = normalizeGhConclusion(run.conclusion);
  return {
    run_id: run.databaseId,
    workflow_name: run.name,
    status,
    conclusion,
    url: run.url,
    ref: run.headBranch,
    sha: run.headSha,
    created_at: run.createdAt,
    finished_at: status === 'completed' ? run.updatedAt : null,
  };
}

function normalizeGl(run: GlRun): NormalizedRun {
  const status = normalizeGlStatus(run.status);
  const conclusion = normalizeGlConclusion(run.status);
  return {
    run_id: run.id,
    workflow_name: run.name ?? run.source ?? '',
    status,
    conclusion,
    url: run.web_url,
    ref: run.ref,
    sha: run.sha,
    created_at: run.created_at,
    finished_at: run.finished_at ?? (status === 'completed' ? run.updated_at : null),
  };
}

const ciRunStatusHandler: HandlerDef = {
  name: 'ci_run_status',
  description:
    'Get the latest CI workflow/pipeline run status for a commit SHA or branch ref, optionally filtered by workflow name.',
  inputSchema,
  async execute(rawArgs: unknown) {
    let args: Input;
    try {
      args = inputSchema.parse(rawArgs);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ ok: false, error }) },
        ],
      };
    }

    try {
      const platform = detectPlatform();

      let normalized: NormalizedRun | null = null;

      if (platform === 'github') {
        const runs = ghQueryRuns(args.ref, args.workflow_name);
        if (runs.length > 0) {
          normalized = normalizeGh(runs[0]);
        }
      } else {
        const runs = glQueryRuns(args.ref, args.workflow_name);
        if (runs.length > 0) {
          normalized = normalizeGl(runs[0]);
        }
      }

      if (!normalized) {
        const filter = args.workflow_name
          ? ` with workflow '${args.workflow_name}'`
          : '';
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                code: 'no_runs_found',
                error: `no CI runs found for ref '${args.ref}'${filter}`,
              }),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ ok: true, data: normalized }),
          },
        ],
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ ok: false, error }) },
        ],
      };
    }
  },
};

export default ciRunStatusHandler;
