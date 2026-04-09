// Origin Operations family handler.
// See docs/handlers/origin-operations-guide.md for the canonical pattern,
// gh ↔ glab field mappings, and normalized response schemas.

import { execSync } from 'child_process';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { detectPlatform } from '../lib/glab.js';

const HARD_MAX_LINES = 10000;
const DEFAULT_MAX_LINES = 2000;

const inputSchema = z.object({
  run_id: z.number().int().nonnegative(),
  job_id: z.number().int().nonnegative().optional(),
  failed_only: z.boolean().optional().default(true),
  max_lines: z.number().int().positive().optional().default(DEFAULT_MAX_LINES),
});

type Input = z.infer<typeof inputSchema>;

interface FetchResult {
  logs: string;
  job_id: number | null;
  url: string;
}

function exec(cmd: string): string {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 64 });
}

function parseRepoSlug(): string | null {
  try {
    const url = execSync('git remote get-url origin', { encoding: 'utf8' }).trim();
    const m = /[/:]([^/]+)\/([^/.]+?)(\.git)?$/.exec(url);
    if (m) return `${m[1]}/${m[2]}`;
    return null;
  } catch {
    return null;
  }
}

function fetchGithub(args: Input): FetchResult {
  const parts = ['gh run view', String(args.run_id)];
  if (args.job_id !== undefined) {
    parts.push('--job', String(args.job_id));
  }
  parts.push(args.failed_only ? '--log-failed' : '--log');
  const cmd = parts.join(' ');
  const logs = exec(cmd);

  const slug = parseRepoSlug();
  const url = slug
    ? `https://github.com/${slug}/actions/runs/${args.run_id}`
    : `https://github.com/actions/runs/${args.run_id}`;

  return {
    logs,
    job_id: args.job_id ?? null,
    url,
  };
}

interface GitlabJob {
  id: number;
  status: string;
  web_url?: string;
}

function gitlabProjectPath(): string {
  // URL-encoded project path for glab api
  const slug = parseRepoSlug();
  if (!slug) throw new Error('could not parse gitlab project path from origin url');
  return encodeURIComponent(slug);
}

function fetchGitlab(args: Input): FetchResult {
  let jobId = args.job_id;

  if (jobId === undefined) {
    // Fetch the first failed job from the pipeline
    const projectPath = gitlabProjectPath();
    const raw = exec(`glab api projects/${projectPath}/pipelines/${args.run_id}/jobs`);
    const jobs = JSON.parse(raw) as GitlabJob[];
    const failed = jobs.find(j => j.status === 'failed');
    if (!failed) {
      throw new Error(`no failed job found in pipeline ${args.run_id}`);
    }
    jobId = failed.id;
  }

  const logs = exec(`glab ci trace ${jobId}`);

  const slug = parseRepoSlug();
  const url = slug
    ? `https://gitlab.com/${slug}/-/jobs/${jobId}`
    : `https://gitlab.com/-/jobs/${jobId}`;

  return {
    logs,
    job_id: jobId,
    url,
  };
}

interface TruncationResult {
  logs: string;
  line_count: number;
  truncated: boolean;
}

export function truncateLogs(rawLogs: string, requestedMax: number): TruncationResult {
  // Enforce hard cap regardless of caller override
  const effectiveMax = Math.min(requestedMax, HARD_MAX_LINES);

  // Split preserving content. Strip a single trailing empty line from a
  // trailing newline so we don't count it as a "line".
  let lines = rawLogs.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines = lines.slice(0, -1);
  }
  const originalCount = lines.length;

  if (originalCount <= effectiveMax) {
    return {
      logs: lines.join('\n'),
      line_count: originalCount,
      truncated: false,
    };
  }

  const halfHead = Math.floor(effectiveMax / 2);
  const halfTail = effectiveMax - halfHead;
  const head = lines.slice(0, halfHead);
  const tail = lines.slice(lines.length - halfTail);
  const omitted = originalCount - head.length - tail.length;
  const marker = `... [${omitted} lines omitted] ...`;

  const out = [...head, marker, ...tail].join('\n');
  // line_count reflects the original log size so callers can see how big the real log was
  return {
    logs: out,
    line_count: originalCount,
    truncated: true,
  };
}

const ciRunLogsHandler: HandlerDef = {
  name: 'ci_run_logs',
  description:
    'Fetch logs for a CI run (GitHub) or pipeline job (GitLab), truncated to keep response size sane. Used by /jfail.',
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
      const fetched =
        platform === 'github' ? fetchGithub(args) : fetchGitlab(args);

      const { logs, line_count, truncated } = truncateLogs(fetched.logs, args.max_lines);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              run_id: args.run_id,
              job_id: fetched.job_id,
              logs,
              line_count,
              truncated,
              url: fetched.url,
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

export default ciRunLogsHandler;
