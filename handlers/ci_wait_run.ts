import { execSync } from 'child_process';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';

const inputSchema = z
  .object({
    ref: z.string().min(1, 'ref must be a non-empty string (commit SHA or branch name)'),
    workflow_name: z.string().optional(),
    poll_interval_sec: z.number().int().positive().optional(),
    timeout_sec: z.number().int().positive().optional(),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

// Defaults.
const DEFAULT_POLL_INTERVAL_SEC = 10;
const MIN_POLL_INTERVAL_SEC = 5; // hard floor
const DEFAULT_TIMEOUT_SEC = 1800; // 30 minutes
const NO_RUN_YET_WINDOW_SEC = 60; // wait up to 60s for a run to appear before main loop
const NO_RUN_YET_POLL_SEC = 5; // how often to poll during the no-run-yet window

// Final-status domain (what we return to the caller).
type FinalStatus = 'success' | 'failure' | 'cancelled' | 'timed_out';

// --- injectable sleep (tests replace with a no-op) ---
let sleepFn: (ms: number) => Promise<void> = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function __setSleep(fn: (ms: number) => Promise<void>): void {
  sleepFn = fn;
}

export function __resetSleep(): void {
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
}

// --- small helpers ---

function exec(cmd: string): string {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

function detectPlatform(): 'github' | 'gitlab' {
  try {
    const url = exec('git remote get-url origin');
    if (url.includes('gitlab')) return 'gitlab';
    return 'github';
  } catch {
    return 'github';
  }
}

function isSha(ref: string): boolean {
  return /^[0-9a-f]{40}$/i.test(ref);
}

function shortRef(ref: string): string {
  return isSha(ref) ? ref.slice(0, 7) : ref;
}

function logPoll(ref: string, elapsedSec: number, status: string): void {
  process.stderr.write(
    `[ci_wait_run] ref=${shortRef(ref)} t=${elapsedSec}s status=${status}\n`
  );
}

// --- normalized poll result ---
interface RunSnapshot {
  run_id: number;
  workflow_name: string;
  status: string; // raw platform status: "queued" | "in_progress" | "completed" | ...
  conclusion: string | null; // only populated when completed
  url: string;
  sha: string;
}

// Shell-quote a value so it is safe inside double quotes.
function shellQuote(value: string): string {
  return value.replace(/(["\\$`])/g, '\\$1');
}

// --- GitHub polling ---

function githubListCmd(ref: string, workflowName: string | undefined): string {
  const quotedRef = shellQuote(ref);
  const refFlag = isSha(ref) ? `--commit "${quotedRef}"` : `--branch "${quotedRef}"`;
  const workflowFlag = workflowName
    ? ` --workflow "${shellQuote(workflowName)}"`
    : '';
  // Pull a generous set of fields so we can surface good error messages.
  return `gh run list ${refFlag}${workflowFlag} --limit 20 --json databaseId,name,status,conclusion,url,headSha,headBranch,workflowName,createdAt`;
}

interface GithubRun {
  databaseId: number;
  name?: string;
  workflowName?: string;
  status: string;
  conclusion: string | null;
  url: string;
  headSha: string;
  headBranch?: string;
  createdAt?: string;
}

function fetchGithubRuns(
  ref: string,
  workflowName: string | undefined
): GithubRun[] {
  const cmd = githubListCmd(ref, workflowName);
  let raw: string;
  try {
    raw = exec(cmd);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `gh run list failed for ref '${ref}': ${msg}. Is 'gh' authenticated and is the ref pushed to origin?`
    );
  }
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`gh run list returned non-JSON output: ${raw.slice(0, 200)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `gh run list returned unexpected shape (expected array): ${String(parsed).slice(0, 200)}`
    );
  }
  return parsed as GithubRun[];
}

function pickGithubRun(
  runs: GithubRun[],
  workflowName: string | undefined
): GithubRun | null {
  if (runs.length === 0) return null;
  const filtered = workflowName
    ? runs.filter(
        (r) => r.workflowName === workflowName || r.name === workflowName
      )
    : runs;
  if (filtered.length === 0) return null;
  // Prefer the newest run when multiple match. gh already returns in reverse chrono order,
  // but be explicit so tests don't depend on that.
  const sorted = [...filtered].sort((a, b) => {
    const at = a.createdAt ? Date.parse(a.createdAt) : 0;
    const bt = b.createdAt ? Date.parse(b.createdAt) : 0;
    return bt - at;
  });
  return sorted[0];
}

function githubSnapshot(run: GithubRun): RunSnapshot {
  return {
    run_id: run.databaseId,
    workflow_name: run.workflowName ?? run.name ?? '(unknown)',
    status: run.status,
    conclusion: run.conclusion ?? null,
    url: run.url,
    sha: run.headSha,
  };
}

// --- GitLab polling ---

function gitlabListCmd(ref: string): string {
  const quotedRef = shellQuote(ref);
  // glab ci list flags vary across versions; --sha is for commits, --branch for branches.
  const refFlag = isSha(ref) ? `--sha "${quotedRef}"` : `--branch "${quotedRef}"`;
  return `glab ci list ${refFlag} --output json`;
}

interface GitlabPipeline {
  id: number;
  status: string;
  ref?: string;
  sha?: string;
  web_url?: string;
  name?: string;
  // Some glab versions return snake_case, some camelCase. Accept both for safety.
  created_at?: string;
  createdAt?: string;
}

function fetchGitlabPipelines(ref: string): GitlabPipeline[] {
  const cmd = gitlabListCmd(ref);
  let raw: string;
  try {
    raw = exec(cmd);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `glab ci list failed for ref '${ref}': ${msg}. Is 'glab' authenticated and is the ref pushed to origin?`
    );
  }
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`glab ci list returned non-JSON output: ${raw.slice(0, 200)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `glab ci list returned unexpected shape (expected array): ${String(parsed).slice(0, 200)}`
    );
  }
  return parsed as GitlabPipeline[];
}

function pickGitlabPipeline(
  pipelines: GitlabPipeline[],
  workflowName: string | undefined
): GitlabPipeline | null {
  if (pipelines.length === 0) return null;
  // GitLab doesn't really have "workflow names" the way GH Actions does; filter by `name`
  // if the caller asked, otherwise take the newest.
  const filtered = workflowName
    ? pipelines.filter((p) => p.name === workflowName)
    : pipelines;
  if (filtered.length === 0) return null;
  const sorted = [...filtered].sort((a, b) => {
    const at = a.created_at ?? a.createdAt;
    const bt = b.created_at ?? b.createdAt;
    const ap = at ? Date.parse(at) : 0;
    const bp = bt ? Date.parse(bt) : 0;
    return bp - ap;
  });
  return sorted[0];
}

// GitLab pipeline status values: created, waiting_for_resource, preparing, pending, running,
// success, failed, canceled, skipped, manual, scheduled.
// Normalize to the same vocabulary the handler uses internally.
function normalizeGitlabStatus(status: string): {
  status: string;
  conclusion: string | null;
} {
  switch (status) {
    case 'success':
      return { status: 'completed', conclusion: 'success' };
    case 'failed':
      return { status: 'completed', conclusion: 'failure' };
    case 'canceled':
    case 'cancelled':
      return { status: 'completed', conclusion: 'cancelled' };
    case 'skipped':
      // Treat skipped as success — there's nothing to wait on.
      return { status: 'completed', conclusion: 'success' };
    case 'running':
    case 'pending':
    case 'preparing':
    case 'waiting_for_resource':
    case 'created':
    case 'scheduled':
    case 'manual':
      return { status: 'in_progress', conclusion: null };
    default:
      return { status, conclusion: null };
  }
}

function gitlabSnapshot(pipeline: GitlabPipeline): RunSnapshot {
  const normalized = normalizeGitlabStatus(pipeline.status);
  return {
    run_id: pipeline.id,
    workflow_name: pipeline.name ?? '(gitlab pipeline)',
    status: normalized.status,
    conclusion: normalized.conclusion,
    url: pipeline.web_url ?? '',
    sha: pipeline.sha ?? '',
  };
}

// --- unified fetch ---

function fetchSnapshot(
  platform: 'github' | 'gitlab',
  ref: string,
  workflowName: string | undefined
): RunSnapshot | null {
  if (platform === 'github') {
    const runs = fetchGithubRuns(ref, workflowName);
    const picked = pickGithubRun(runs, workflowName);
    return picked ? githubSnapshot(picked) : null;
  }
  const pipelines = fetchGitlabPipelines(ref);
  const picked = pickGitlabPipeline(pipelines, workflowName);
  return picked ? gitlabSnapshot(picked) : null;
}

// --- conclusion normalization (GitHub conclusions: success, failure, cancelled,
//     timed_out, action_required, neutral, skipped, stale) ---

function normalizeConclusion(
  conclusion: string | null
): FinalStatus | 'unknown' {
  if (!conclusion) return 'unknown';
  switch (conclusion) {
    case 'success':
    case 'skipped':
    case 'neutral':
      return 'success';
    case 'failure':
    case 'timed_out':
    case 'action_required':
    case 'stale':
      return 'failure';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    default:
      return 'unknown';
  }
}

// --- the main handler ---

const ciWaitRunHandler: HandlerDef = {
  name: 'ci_wait_run',
  description:
    "Block on a CI workflow/pipeline run for a commit SHA or branch ref, polling server-side until it completes or times out. Returns the final status without burning agent tokens in a busy-wait loop.",
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

    // Enforce hard floor on poll interval.
    const requestedInterval = args.poll_interval_sec ?? DEFAULT_POLL_INTERVAL_SEC;
    const pollIntervalSec = Math.max(requestedInterval, MIN_POLL_INTERVAL_SEC);
    const timeoutSec = args.timeout_sec ?? DEFAULT_TIMEOUT_SEC;
    const ref = args.ref;
    const workflowName = args.workflow_name;

    const platform = detectPlatform();
    const startMs = Date.now();
    const elapsedSec = (): number =>
      Math.floor((Date.now() - startMs) / 1000);

    try {
      // --- Phase 1: wait for a run to appear (no-run-yet window) ---
      let snapshot: RunSnapshot | null = null;
      while (elapsedSec() < NO_RUN_YET_WINDOW_SEC) {
        snapshot = fetchSnapshot(platform, ref, workflowName);
        if (snapshot) break;
        logPoll(ref, elapsedSec(), 'no_run_yet');
        // Also honor the overall timeout — don't exceed it here.
        if (elapsedSec() >= timeoutSec) break;
        await sleepFn(NO_RUN_YET_POLL_SEC * 1000);
      }

      if (!snapshot) {
        // No run appeared in the window. That's a timeout, but with a specific explanation.
        const waited = elapsedSec();
        const filterMsg = workflowName
          ? ` (filtered by workflow_name='${workflowName}')`
          : '';
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: `No CI run found for ref '${ref}'${filterMsg} after waiting ${waited}s. The pipeline may not have been triggered, or the ref has not been pushed to origin. Verify with: gh run list --${isSha(ref) ? 'commit' : 'branch'} ${ref}`,
                waited_sec: waited,
                ref,
                platform,
              }),
            },
          ],
        };
      }

      // --- Phase 2: poll the run until it completes or we time out ---
      // Log the first snapshot we picked up.
      logPoll(ref, elapsedSec(), snapshot.status);

      while (snapshot.status !== 'completed') {
        if (elapsedSec() >= timeoutSec) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  ok: true,
                  run_id: snapshot.run_id,
                  workflow_name: snapshot.workflow_name,
                  final_status: 'timed_out' satisfies FinalStatus,
                  url: snapshot.url,
                  ref,
                  sha: snapshot.sha,
                  waited_sec: elapsedSec(),
                  message: `ci_wait_run hit timeout_sec=${timeoutSec} while run was still '${snapshot.status}'. The run is still executing on the server — check ${snapshot.url}.`,
                }),
              },
            ],
          };
        }
        await sleepFn(pollIntervalSec * 1000);
        // Refresh snapshot.
        const next = fetchSnapshot(platform, ref, workflowName);
        if (!next) {
          // Unusual — the run vanished between polls. Keep the previous snapshot and log.
          logPoll(ref, elapsedSec(), `${snapshot.status}(stale,no_run_returned)`);
          continue;
        }
        snapshot = next;
        logPoll(ref, elapsedSec(), snapshot.status);
      }

      // --- Phase 3: completed — map conclusion to final_status ---
      const finalStatus = normalizeConclusion(snapshot.conclusion);
      if (finalStatus === 'unknown') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: `Run completed with unrecognized conclusion '${snapshot.conclusion ?? 'null'}'. run_id=${snapshot.run_id} url=${snapshot.url}`,
                run_id: snapshot.run_id,
                workflow_name: snapshot.workflow_name,
                url: snapshot.url,
                ref,
                sha: snapshot.sha,
                waited_sec: elapsedSec(),
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
              run_id: snapshot.run_id,
              workflow_name: snapshot.workflow_name,
              final_status: finalStatus,
              url: snapshot.url,
              ref,
              sha: snapshot.sha,
              waited_sec: elapsedSec(),
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
            text: JSON.stringify({
              ok: false,
              error,
              ref,
              platform,
              waited_sec: elapsedSec(),
            }),
          },
        ],
      };
    }
  },
};

export default ciWaitRunHandler;
