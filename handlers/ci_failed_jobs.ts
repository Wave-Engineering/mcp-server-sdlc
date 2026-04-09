// Origin Operations family handler.
// See docs/handlers/origin-operations-guide.md for the canonical pattern,
// gh ↔ glab field mappings, and normalized response schemas.

import { execSync } from 'child_process';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';

const inputSchema = z
  .object({
    run_id: z.number().int().positive(),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

interface FailedJob {
  job_id: number;
  name: string;
  stage: string | null;
  conclusion: string;
  started_at: string | null;
  finished_at: string | null;
  url: string;
}

function exec(cmd: string): string {
  return execSync(cmd, { encoding: 'utf8' });
}

function detectPlatform(): 'github' | 'gitlab' {
  try {
    const url = exec('git remote get-url origin').trim();
    return url.includes('github') ? 'github' : 'gitlab';
  } catch {
    return 'github';
  }
}

// GitHub job shape from `gh run view <id> --json jobs`.
interface GithubJob {
  databaseId?: number;
  name?: string;
  status?: string;
  conclusion?: string;
  startedAt?: string;
  completedAt?: string;
  url?: string;
}

// GitLab job shape from `glab api projects/:id/pipelines/<id>/jobs`.
interface GitlabJob {
  id?: number;
  name?: string;
  status?: string;
  stage?: string;
  started_at?: string | null;
  finished_at?: string | null;
  web_url?: string;
}

function normalizeGithubConclusion(raw: string | undefined): string {
  // GitHub conclusion values: success, failure, cancelled, timed_out,
  // action_required, neutral, skipped, stale, startup_failure.
  if (!raw) return 'failure';
  return raw;
}

function normalizeGitlabConclusion(raw: string | undefined): string {
  // GitLab job status after filtering to `failed`. Map onto GitHub-style
  // conclusions so `/jfail` can reason about both uniformly.
  if (!raw) return 'failure';
  if (raw === 'failed') return 'failure';
  return raw;
}

function fetchGithubFailedJobs(runId: number): FailedJob[] {
  const raw = exec(`gh run view ${runId} --json jobs`);
  const parsed = JSON.parse(raw) as { jobs?: GithubJob[] };
  const jobs = parsed.jobs ?? [];
  const failed: FailedJob[] = [];
  for (const j of jobs) {
    if (j.status !== 'completed') continue;
    if (j.conclusion === 'success') continue;
    failed.push({
      job_id: j.databaseId ?? 0,
      name: j.name ?? '',
      stage: null,
      conclusion: normalizeGithubConclusion(j.conclusion),
      started_at: j.startedAt ?? null,
      finished_at: j.completedAt ?? null,
      url: j.url ?? '',
    });
  }
  return failed;
}

function fetchGitlabFailedJobs(runId: number): FailedJob[] {
  // glab substitutes `:id` with the current project's numeric id.
  const raw = exec(`glab api projects/:id/pipelines/${runId}/jobs`);
  const parsed = JSON.parse(raw) as GitlabJob[];
  const failed: FailedJob[] = [];
  for (const j of parsed) {
    if (j.status !== 'failed') continue;
    failed.push({
      job_id: j.id ?? 0,
      name: j.name ?? '',
      stage: j.stage ?? null,
      conclusion: normalizeGitlabConclusion(j.status),
      started_at: j.started_at ?? null,
      finished_at: j.finished_at ?? null,
      url: j.web_url ?? '',
    });
  }
  return failed;
}

const ciFailedJobsHandler: HandlerDef = {
  name: 'ci_failed_jobs',
  description:
    'List failed jobs for a specific CI run with per-job reason summaries. Used by /jfail to know which jobs to pull logs for.',
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
      const failed =
        platform === 'github'
          ? fetchGithubFailedJobs(args.run_id)
          : fetchGitlabFailedJobs(args.run_id);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              run_id: args.run_id,
              failed_jobs: failed,
            }),
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

export default ciFailedJobsHandler;
