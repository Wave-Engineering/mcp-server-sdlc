import { execSync } from 'child_process';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';

const inputSchema = z.object({
  number: z.number().int().positive(),
});

type Input = z.infer<typeof inputSchema>;

type State = 'open' | 'merged' | 'closed';
type MergeState = 'clean' | 'unstable' | 'dirty' | 'blocked' | 'unknown';
type ChecksSummary = 'all_passed' | 'has_failures' | 'pending' | 'none';

interface ChecksAggregate {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  summary: ChecksSummary;
}

interface PrStatusResponse {
  number: number;
  state: State;
  merge_state: MergeState;
  mergeable: boolean;
  checks: ChecksAggregate;
  url: string;
}

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

// --- GitHub normalization ---

function normalizeGithubState(state: string): State {
  const s = state.toUpperCase();
  if (s === 'MERGED') return 'merged';
  if (s === 'CLOSED') return 'closed';
  return 'open';
}

function normalizeGithubMergeState(mergeStateStatus: string): MergeState {
  const s = (mergeStateStatus || '').toUpperCase();
  if (s === 'CLEAN') return 'clean';
  if (s === 'UNSTABLE') return 'unstable';
  if (s === 'DIRTY') return 'dirty';
  if (s === 'BLOCKED') return 'blocked';
  return 'unknown';
}

interface GithubCheck {
  name?: string;
  state?: string;
  conclusion?: string | null;
}

function aggregateGithubChecks(checks: GithubCheck[]): ChecksAggregate {
  let passed = 0;
  let failed = 0;
  let pending = 0;

  for (const c of checks) {
    const conclusion = (c.conclusion ?? '').toLowerCase();
    const state = (c.state ?? '').toLowerCase();

    if (conclusion === 'success' || state === 'success') {
      passed += 1;
    } else if (
      conclusion === 'failure' ||
      conclusion === 'cancelled' ||
      conclusion === 'timed_out' ||
      conclusion === 'action_required' ||
      state === 'failure'
    ) {
      failed += 1;
    } else {
      // null conclusion, in_progress, queued, pending, etc.
      pending += 1;
    }
  }

  const total = checks.length;
  let summary: ChecksSummary;
  if (total === 0) {
    summary = 'none';
  } else if (failed > 0) {
    summary = 'has_failures';
  } else if (pending > 0) {
    summary = 'pending';
  } else {
    summary = 'all_passed';
  }

  return { total, passed, failed, pending, summary };
}

function getGithubPrStatus(num: number): PrStatusResponse {
  const rawPr = exec(
    `gh pr view ${num} --json state,mergeStateStatus,mergeable,url`,
  );
  const pr = JSON.parse(rawPr) as {
    state: string;
    mergeStateStatus: string;
    mergeable: string | boolean;
    url: string;
  };

  const state = normalizeGithubState(pr.state);
  const merge_state = normalizeGithubMergeState(pr.mergeStateStatus);
  // GitHub `mergeable` comes back as "MERGEABLE" | "CONFLICTING" | "UNKNOWN" or bool.
  const mergeableRaw =
    typeof pr.mergeable === 'string' ? pr.mergeable.toUpperCase() : pr.mergeable;
  const mergeable =
    mergeableRaw === true || mergeableRaw === 'MERGEABLE' ? true : false;

  let checks: ChecksAggregate = { total: 0, passed: 0, failed: 0, pending: 0, summary: 'none' };
  try {
    const rawChecks = exec(`gh pr checks ${num} --json name,state,conclusion`);
    const parsed = JSON.parse(rawChecks) as GithubCheck[];
    checks = aggregateGithubChecks(parsed);
  } catch {
    // No checks configured or command failed — leave as 'none'.
  }

  return {
    number: num,
    state,
    merge_state,
    mergeable,
    checks,
    url: pr.url,
  };
}

// --- GitLab normalization ---

function normalizeGitlabState(state: string): State {
  const s = (state || '').toLowerCase();
  if (s === 'merged') return 'merged';
  if (s === 'closed') return 'closed';
  return 'open';
}

function normalizeGitlabMergeState(
  detailedMergeStatus: string | undefined,
  mergeStatus: string | undefined,
): MergeState {
  const dm = (detailedMergeStatus || '').toLowerCase();
  if (dm === 'mergeable') return 'clean';
  if (dm === 'ci_still_running' || dm === 'checking') return 'unknown';
  if (
    dm === 'broken_status' ||
    dm === 'conflict' ||
    dm === 'ci_must_pass' ||
    dm === 'discussions_not_resolved' ||
    dm === 'draft_status' ||
    dm === 'not_approved' ||
    dm === 'blocked_status'
  ) {
    // conflicts are "dirty", other blockers are "blocked"
    if (dm === 'conflict' || dm === 'broken_status') return 'dirty';
    return 'blocked';
  }
  // Fall back to legacy `merge_status`: can_be_merged / cannot_be_merged / unchecked
  const ms = (mergeStatus || '').toLowerCase();
  if (ms === 'can_be_merged') return 'clean';
  if (ms === 'cannot_be_merged') return 'dirty';
  return 'unknown';
}

function aggregateGitlabPipeline(
  pipelineStatus: string | undefined,
): ChecksAggregate {
  if (!pipelineStatus) {
    return { total: 0, passed: 0, failed: 0, pending: 0, summary: 'none' };
  }
  const s = pipelineStatus.toLowerCase();
  if (s === 'success') {
    return { total: 1, passed: 1, failed: 0, pending: 0, summary: 'all_passed' };
  }
  if (s === 'failed' || s === 'canceled' || s === 'cancelled') {
    return { total: 1, passed: 0, failed: 1, pending: 0, summary: 'has_failures' };
  }
  // running, pending, created, scheduled, preparing, waiting_for_resource, manual
  return { total: 1, passed: 0, failed: 0, pending: 1, summary: 'pending' };
}

function getGitlabMrStatus(num: number): PrStatusResponse {
  const raw = exec(`glab mr view ${num} --output json`);
  const mr = JSON.parse(raw) as {
    iid?: number;
    state: string;
    merge_status?: string;
    detailed_merge_status?: string;
    web_url: string;
    pipeline?: { status?: string } | null;
    head_pipeline?: { status?: string } | null;
  };

  const state = normalizeGitlabState(mr.state);
  const merge_state = normalizeGitlabMergeState(mr.detailed_merge_status, mr.merge_status);
  const mergeable = merge_state === 'clean';

  const pipelineStatus = mr.pipeline?.status ?? mr.head_pipeline?.status;
  const checks = aggregateGitlabPipeline(pipelineStatus);

  return {
    number: num,
    state,
    merge_state,
    mergeable,
    checks,
    url: mr.web_url,
  };
}

const prStatusHandler: HandlerDef = {
  name: 'pr_status',
  description:
    'Get the current state of a PR/MR: open/merged/closed, merge state (clean/unstable/dirty/blocked/unknown), mergeable flag, and a summary of check runs. Used by /mmr to verify CI before merging.',
  inputSchema,
  async execute(rawArgs: unknown) {
    let args: Input;
    try {
      args = inputSchema.parse(rawArgs) as Input;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error }) }],
      };
    }

    try {
      const platform = detectPlatform();
      const data =
        platform === 'github'
          ? getGithubPrStatus(args.number)
          : getGitlabMrStatus(args.number);

      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ ok: true, data }) },
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

export default prStatusHandler;
