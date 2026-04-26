/**
 * GitHub `ci_run_status` adapter implementation.
 *
 * Lifted from `handlers/ci_run_status.ts` per Story 2.13 (#307). The handler
 * is now a thin dispatcher; this module owns the GitHub-specific subprocess
 * work (argv composition + `gh run list` invocation) AND the
 * platform-shape-to-normalized-shape enum mapping (`normalizeGh*`).
 *
 * Argv composition:
 *   gh run list (--commit <sha> | --branch <ref>) [--workflow <name>]
 *     [--repo <slug>] --limit 1 --json databaseId,name,status,conclusion,url,
 *     headBranch,headSha,createdAt,updatedAt
 *
 * SHA detection: a 40-character lowercase hex string is treated as a commit
 * SHA; anything else as a branch ref. Mirrors pre-migration behavior.
 */

import { execSync } from 'child_process';
import { runArgv } from '../shared/error-norm.js';
import type {
  AdapterResult,
  CiRunConclusion,
  CiRunStatus,
  CiRunStatusArgs,
  CiRunStatusResponse,
  NormalizedRun,
} from './types.js';

const SHA_PATTERN = /^[0-9a-f]{40}$/i;

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

function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

function isSha(ref: string): boolean {
  return SHA_PATTERN.test(ref);
}

function normalizeGhStatus(status: string): CiRunStatus {
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

function normalizeGhConclusion(value: string | null): CiRunConclusion | null {
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

export async function ciRunStatusGithub(
  args: CiRunStatusArgs,
): Promise<AdapterResult<CiRunStatusResponse>> {
  try {
    const cwd = projectDir();

    const cmd: string[] = ['gh', 'run', 'list'];
    if (isSha(args.ref)) {
      cmd.push('--commit', args.ref);
    } else {
      cmd.push('--branch', args.ref);
    }
    if (args.workflow_name !== undefined) {
      cmd.push('--workflow', args.workflow_name);
    }
    if (args.repo !== undefined) {
      cmd.push('--repo', args.repo);
    }
    cmd.push(
      '--limit',
      '1',
      '--json',
      'databaseId,name,status,conclusion,url,headBranch,headSha,createdAt,updatedAt',
    );

    const result = runArgv(cmd, cwd);
    if (result.exitCode !== 0) {
      return {
        ok: false,
        code: 'gh_run_list_failed',
        error: `gh run list failed: ${result.stderr.trim() || result.stdout.trim()}`,
      };
    }

    const raw = result.stdout.trim();
    if (!raw) return { ok: true, data: null };

    const runs = JSON.parse(raw) as GhRun[];
    if (runs.length === 0) return { ok: true, data: null };

    return { ok: true, data: normalizeGh(runs[0]) };
  } catch (err) {
    return {
      ok: false,
      code: 'unexpected_error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// `execSync` is intentionally re-imported above so that adapter-level test
// files can `mock.module('child_process', ...)` and intercept this module's
// subprocess calls without needing access to the handler's mock setup.
void execSync;
