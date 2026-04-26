// Origin Operations family handler.
// See docs/handlers/origin-operations-guide.md for the canonical pattern,
// gh ↔ glab field mappings, and normalized response schemas.

import { execSync } from 'child_process';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { detectPlatform } from '../lib/shared/detect-platform.js';
import { parseRepoSlug } from '../lib/shared/parse-repo-slug.js';
import { gitlabApiCiList, type GitlabPipeline } from '../lib/glab.js';
import { log } from '../logger.js';

const inputSchema = z
  .object({
    ref: z.string().min(1, 'ref must be a non-empty string (commit SHA or branch name)'),
    workflow_name: z.string().optional(),
    poll_interval_sec: z.number().int().positive().optional(),
    timeout_sec: z.number().int().positive().optional(),
    repo: z
      .string()
      .regex(/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/, 'repo must be in owner/repo form')
      .optional(),
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
// `not_applicable` covers merge-queue-only repos whose CI has no push:main
// trigger — there's nothing to wait on, but the merge_group run that gated
// the PR already ran and we can surface that fact distinctly from failure.
type FinalStatus =
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'timed_out'
  | 'not_applicable';

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

function isSha(ref: string): boolean {
  return /^[0-9a-f]{40}$/i.test(ref);
}

function shortRef(ref: string): string {
  return isSha(ref) ? ref.slice(0, 7) : ref;
}

function logPoll(ref: string, elapsedSec: number, status: string): void {
  log.debug('poll', { tool: 'ci_wait_run', ref: shortRef(ref), elapsed_sec: elapsedSec, status });
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

// Split a validated `owner/repo` slug into the opts shape expected by
// lib/glab.ts wrappers. Returns undefined when repo is not provided so
// callers fall back to cwd resolution.
function splitRepoSlug(
  repo: string | undefined,
): { owner: string; repo: string } | undefined {
  if (!repo) return undefined;
  const [owner, name] = repo.split('/', 2);
  return { owner, repo: name };
}

// Resolve a branch ref to its HEAD commit SHA via `gh api`.
// Only invoked when we need to compare a branch ref against a run.headSha
// (e.g. merge-queue fallback). Uses the same authenticated gh subprocess
// pattern the rest of the handler relies on. Returns null if resolution
// fails for any reason — the caller treats that as "no SHA match".
function resolveBranchToSha(slug: string, branch: string): string | null {
  try {
    const sha = exec(
      `gh api repos/${slug}/git/refs/heads/${shellQuote(branch)} --jq .object.sha`
    );
    if (/^[0-9a-f]{40}$/i.test(sha)) return sha;
    return null;
  } catch {
    return null;
  }
}

// --- GitHub polling ---

function githubListCmd(
  ref: string,
  workflowName: string | undefined,
  repo: string | undefined,
): string {
  const quotedRef = shellQuote(ref);
  const refFlag = isSha(ref) ? `--commit "${quotedRef}"` : `--branch "${quotedRef}"`;
  const workflowFlag = workflowName
    ? ` --workflow "${shellQuote(workflowName)}"`
    : '';
  const repoFlag = repo ? ` --repo "${shellQuote(repo)}"` : '';
  // Pull a generous set of fields so we can surface good error messages.
  return `gh run list ${refFlag}${workflowFlag}${repoFlag} --limit 20 --json databaseId,name,status,conclusion,url,headSha,headBranch,workflowName,createdAt,event`;
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
  event?: string;
}

function fetchGithubRuns(
  ref: string,
  workflowName: string | undefined,
  repo: string | undefined,
): GithubRun[] {
  const cmd = githubListCmd(ref, workflowName, repo);
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

function fetchGitlabPipelines(
  ref: string,
  repo: string | undefined,
): GitlabPipeline[] {
  try {
    const opts = splitRepoSlug(repo);
    return gitlabApiCiList({ ref, limit: 20 }, opts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `GitLab API pipelines list failed for ref '${ref}': ${msg}. Is 'glab' authenticated and is the ref pushed to origin?`
    );
  }
}

function pickGitlabPipeline(
  pipelines: GitlabPipeline[],
  workflowName: string | undefined
): GitlabPipeline | null {
  if (pipelines.length === 0) return null;
  // GitLab doesn't really have "workflow names" the way GH Actions does; filter by `source`
  // if the caller asked, otherwise take the newest.
  const filtered = workflowName
    ? pipelines.filter((p) => p.source === workflowName)
    : pipelines;
  if (filtered.length === 0) return null;
  const sorted = [...filtered].sort((a, b) => {
    const at = a.created_at;
    const bt = b.created_at;
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
    workflow_name: pipeline.source ?? '(gitlab pipeline)',
    status: normalized.status,
    conclusion: normalized.conclusion,
    url: pipeline.web_url,
    sha: pipeline.sha,
  };
}

// --- unified fetch ---

function fetchSnapshot(
  platform: 'github' | 'gitlab',
  ref: string,
  workflowName: string | undefined,
  repo: string | undefined,
): RunSnapshot | null {
  if (platform === 'github') {
    const runs = fetchGithubRuns(ref, workflowName, repo);
    const picked = pickGithubRun(runs, workflowName);
    return picked ? githubSnapshot(picked) : null;
  }
  const pipelines = fetchGitlabPipelines(ref, repo);
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
    "Block on a CI workflow/pipeline run for a commit SHA or branch ref, polling server-side until it completes or times out. Returns the final status without burning agent tokens in a busy-wait loop. Merge-queue-only GitHub repos (workflows gated on `merge_group`/`pull_request` with no `push` trigger) are handled specially: if no push-triggered runs exist for the ref but a `merge_group` run matches its HEAD SHA, returns `final_status: \"not_applicable\"` with `reason: \"merge_group_validated\"` — distinguishable from a real failure.",
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
    const repo = args.repo;

    const platform = detectPlatform();
    const startMs = Date.now();
    const elapsedSec = (): number =>
      Math.floor((Date.now() - startMs) / 1000);

    try {
      // --- Phase 0 (GitHub only): merge-queue pre-flight ---
      // If the ref has NO push-triggered runs but DOES have a merge_group run
      // matching its HEAD SHA, treat that as validation — don't wait for a
      // push-triggered run that will never arrive.
      if (platform === 'github') {
        const initialRuns = fetchGithubRuns(ref, workflowName, repo);
        if (initialRuns.length > 0) {
          const anyPush = initialRuns.some((r) => r.event === 'push');
          if (!anyPush) {
            // Resolve ref to a HEAD SHA for comparison against run.headSha.
            let headSha: string | null = isSha(ref) ? ref.toLowerCase() : null;
            if (!headSha) {
              // When `repo` is explicitly provided, skip cwd-based slug
              // parsing and pass the caller's slug directly.
              const slug = repo ?? parseRepoSlug();
              if (slug) headSha = resolveBranchToSha(slug, ref);
            }
            const mergeGroupMatch = initialRuns.find(
              (r) =>
                r.event === 'merge_group' &&
                headSha !== null &&
                r.headSha?.toLowerCase() === headSha
            );
            if (mergeGroupMatch) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: JSON.stringify({
                      ok: true,
                      final_status: 'not_applicable' satisfies FinalStatus,
                      reason: 'merge_group_validated',
                      run_id: mergeGroupMatch.databaseId,
                      workflow_name:
                        mergeGroupMatch.workflowName ??
                        mergeGroupMatch.name ??
                        '(unknown)',
                      url: mergeGroupMatch.url,
                      ref,
                      sha: mergeGroupMatch.headSha,
                      waited_sec: 0,
                    }),
                  },
                ],
              };
            }
            // No push-triggered runs and no matching merge_group run. Fail
            // fast with a structured not_applicable error — distinguishable
            // from a real CI failure and from a generic timeout.
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    ok: false,
                    final_status: 'not_applicable' satisfies FinalStatus,
                    error: `ref '${ref}' has no push-triggered workflows and no matching merge_group run found`,
                    ref,
                  }),
                },
              ],
            };
          }
          // At least one push-triggered run exists — fall through to the
          // existing poll loop. (Phase 1 will re-fetch and pick up the run.)
        }
        // Empty initial list → fall through; existing phase 1 handles
        // no-run-yet window and the "no CI run found" error.
      }

      // --- Phase 1: wait for a run to appear (no-run-yet window) ---
      let snapshot: RunSnapshot | null = null;
      while (elapsedSec() < NO_RUN_YET_WINDOW_SEC) {
        snapshot = fetchSnapshot(platform, ref, workflowName, repo);
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
        const next = fetchSnapshot(platform, ref, workflowName, repo);
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
