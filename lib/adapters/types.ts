/**
 * `PlatformAdapter` contract — the typed interface every platform-specific
 * adapter (`github.ts`, `gitlab.ts`) must implement.
 *
 * One method per platform-aware tool. Method signatures use placeholder
 * `unknown` arg/response types that each migration story (Story 1.3 onward)
 * tightens to its concrete handler shape.
 *
 * The `AdapterResult<T>` discriminated union (per R-02 / §5.2) forces callers
 * to handle three distinct outcomes:
 *
 *   - `{ ok: true, data }`            — success
 *   - `{ ok: false, error, code }`    — runtime failure
 *   - `{ platform_unsupported: true, hint }` — structural asymmetry
 *
 * Today's silent-ignore pattern (e.g., `skip_train` on GitLab) collapses the
 * third case into "fake success" — the bug R-03 closes. The discriminator
 * makes the asymmetry a typed signal rather than a thrown exception or a
 * misleading boolean.
 *
 * Story 1.2 ships with empty assemblers — every method returns
 * `{platform_unsupported: true, hint: 'not yet migrated'}`. Each subsequent
 * migration story replaces one method-pair with real implementations and
 * refines that method's arg/response types.
 */

// ---------------------------------------------------------------------------
// Result discriminator (R-02, §5.2)
// ---------------------------------------------------------------------------

export type AdapterResult<T> =
  | { ok: true; data: T; queried_argv?: string[] }
  | { ok: false; error: string; code: string; queried_argv?: string[] }
  | { platform_unsupported: true; hint: string };

/**
 * `queried_argv` — the argv the adapter ACTUALLY executed to produce this
 * result, when it ran a subprocess (#493).
 *
 * Optional and additive: no existing caller changes, and adapters that do not
 * shell out simply omit it. It exists so a "found nothing" message can derive
 * its verify line from the query that ran rather than a hand-written guess at
 * it. #492 is what that guess costs — its suggestion rendered the exact FAILING
 * lookup, so an operator who followed the tool's own advice got an empty result
 * that appeared to confirm the tool's false diagnosis. A hand-written hint can
 * drift from the query; a derived one cannot.
 */

// ---------------------------------------------------------------------------
// Placeholder arg/response types
//
// All start as `unknown` and are tightened to concrete shapes by each
// migration story (Story 1.3 = pr_create, Story 1.4 = pr_diff, etc.).
// Keeping them named (rather than inline `unknown`) lets each story refine
// just one type without re-touching the interface body.
// ---------------------------------------------------------------------------

export interface PrCreateArgs {
  title: string;
  body: string;
  base?: string;
  head?: string;
  draft?: boolean;
  repo?: string;
  /** Working directory for the git/gh|glab invocation; defaults to CLAUDE_PROJECT_DIR ?? process.cwd(). */
  cwd?: string;
}

export interface PrCreateResponse {
  number: number;
  url: string;
  state: 'open';
  head: string;
  base: string;
  /** True when this call created the PR/MR; false when it pre-existed (idempotent path). */
  created: boolean;
}
export interface PrMergeArgs {
  number: number;
  squash_message?: string;
  use_merge_queue?: boolean;
  skip_train?: boolean;
  repo?: string;
  /**
   * Caller-selected merge strategy (#474). `undefined` is treated as `'squash'`
   * by every adapter, so existing callers see no behavior change. Authoritative
   * only on the immediate (non-queue / skip_train) path — on a merge-queue-
   * ENFORCED repo the queue's own configured method governs an enrolled PR.
   */
  merge_method?: MergeMethod;
  /**
   * GitLab-only internal adapter arg (#488) — NOT part of the `pr_merge`
   * MCP tool schema. `pr_merge` never sets this: `glab mr merge` runs with
   * `--auto-merge=false`, so a pipeline-gated MR refuses (loud failure)
   * rather than silently enrolling — the deterministic, merge-now-or-fail
   * contract `pr_merge` advertises (#486).
   *
   * `pr_merge_wait`'s executor sets this to `true`: its whole contract is
   * poll-until-merged, so a pipeline-gated MR should enroll
   * (merge-when-pipeline-succeeds) rather than fail outright — the wait loop
   * (`pollUntilMerged`) is what then carries it to completion. GitHub's
   * adapter ignores this field entirely; GitHub's queue path already has its
   * own enrollment mechanism independent of this flag.
   */
  allow_gitlab_enrollment?: boolean;
}

/**
 * Caller-selected merge strategy passed INTO `pr_merge` / `pr_merge_wait`
 * (#474). Mirrors the three `gh pr merge` / `glab mr merge` strategies. The
 * schema default is `'squash'`, preserving the pre-#474 hardcoded behavior.
 */
export type MergeMethod = 'squash' | 'merge' | 'rebase';

/**
 * The strategy actually used, REPORTED back in `merge_method`. The `direct_*`
 * variants name the method used on the immediate (non-queue) path; `merge_queue`
 * means the PR was enrolled and the queue's own configured method governs the
 * eventual merge — so the requested `MergeMethod` is NOT authoritative there
 * (see the `pr_merge` tool description's queue caveat, #474).
 */
export type PrMergeMethod =
  | 'direct_squash'
  | 'direct_merge'
  | 'direct_rebase'
  | 'merge_queue';

/** Map a caller-selected `MergeMethod` to its direct-path reported label. */
export function directMergeMethodLabel(m: MergeMethod): PrMergeMethod {
  if (m === 'merge') return 'direct_merge';
  if (m === 'rebase') return 'direct_rebase';
  return 'direct_squash';
}

export type PrStateLabel = 'OPEN' | 'MERGED';

export interface PrMergeQueueState {
  enabled: boolean;
  position: number | null;
  enforced: boolean;
}

export interface PrMergeResponse {
  number: number;
  enrolled: boolean;
  merged: boolean;
  merge_method: PrMergeMethod;
  queue: PrMergeQueueState;
  pr_state: PrStateLabel;
  url: string;
  merge_commit_sha?: string;
  warnings: string[];
  /**
   * True when a direct-merge invocation failed with the GitHub queue-strategy
   * error and the adapter silently retried via `--auto` (queue-enqueue path).
   * Defaults to `false` on every other path — including the eager
   * enforced-queue path where `--auto` was chosen upfront. Bug #280 / #294.
   */
  queue_fallback: boolean;
  /**
   * True when the adapter fell back to GraphQL enqueuePullRequest mutation
   * because gh pr merge --auto failed on a merge-queue-on / auto-merge-off repo.
   * Defaults to `false` on every other path. Bug #284.
   */
  graphql_fallback: boolean;
  /**
   * Queue position returned from GraphQL enqueuePullRequest mutation, or null
   * if unavailable. Only populated when graphql_fallback is true. Bug #284.
   */
  queue_position?: number | null;
}
export interface PrMergeWaitArgs {
  number: number;
  squash_message?: string;
  use_merge_queue?: boolean;
  skip_train?: boolean;
  repo?: string;
  timeout_sec?: number;
  /** Caller-selected merge strategy (#474). See `PrMergeArgs.merge_method`. */
  merge_method?: MergeMethod;
}

/**
 * pr_merge_wait returns the same aggregate envelope as pr_merge with the
 * "merged on main" guarantee: on success, `merged === true` and
 * `pr_state === 'MERGED'`. Detect-and-skip emits a warning when the PR was
 * already merged before invocation.
 */
export interface PrMergeWaitResponse {
  number: number;
  enrolled: boolean;
  merged: boolean;
  merge_method: PrMergeMethod;
  queue: PrMergeQueueState;
  pr_state: PrStateLabel;
  url: string;
  merge_commit_sha?: string;
  warnings: string[];
}

/**
 * Hybrid sub-call (Story 1.11). `fetchPrState` is the slim cross-platform
 * PR/MR state fetcher used by both `prMergeWait` (polling until merged) and
 * the per-platform `prMerge` adapters (post-merge URL/sha lookup). Returns
 * only what the merge flow needs — state, url, sha — instead of the rich
 * status payload `prStatus` returns.
 */
export interface FetchPrStateArgs {
  number: number;
  repo?: string;
}

export type PrState = 'open' | 'merged' | 'closed';

export interface PrStateInfo {
  state: PrState;
  url: string;
  mergeCommitSha?: string;
}
export interface PrStatusArgs {
  number: number;
  repo?: string;
}

export type PrStatusState = 'open' | 'merged' | 'closed';
export type PrStatusMergeState = 'clean' | 'unstable' | 'dirty' | 'blocked' | 'unknown';
/**
 * Check-aggregate summary states.
 *
 * - `'all_passed'`        — every check completed successfully.
 * - `'has_failures'`      — at least one check failed.
 * - `'pending'`           — checks are still in flight.
 * - `'none'`              — no checks were configured (or none were reported).
 * - `'no_pipeline_data'`  — GitLab-only: the MR has no pipeline data at all
 *                            (neither `pipeline.status` nor `head_pipeline.status`).
 *                            Distinguishes a misconfigured-CI MR from a
 *                            no-pipeline MR (Story 1.7 explicit-fallthrough fix).
 */
export type PrStatusChecksSummary =
  | 'all_passed'
  | 'has_failures'
  | 'pending'
  | 'none'
  | 'no_pipeline_data';

export interface PrStatusChecksAggregate {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  summary: PrStatusChecksSummary;
}

export interface PrStatusResponse {
  number: number;
  state: PrStatusState;
  merge_state: PrStatusMergeState;
  mergeable: boolean;
  checks: PrStatusChecksAggregate;
  url: string;
}
export interface PrDiffArgs {
  number: number;
  repo?: string;
}

export interface PrDiffResponse {
  number: number;
  diff: string;
  line_count: number;
  file_count: number;
  url: string;
  truncated: boolean;
}
export interface PrCommentArgs {
  number: number;
  body: string;
  repo?: string;
  target?: 'issue' | 'mr';
}

export interface PrCommentResponse {
  number: number;
  comment_id: number;
  url: string;
}
export interface PrFilesArgs {
  number: number;
  repo?: string;
}

export type PrFilesStatus = 'added' | 'modified' | 'removed' | 'renamed';

export interface PrFilesEntry {
  path: string;
  status: PrFilesStatus;
  additions: number;
  deletions: number;
}

export interface PrFilesResponse {
  number: number;
  files: PrFilesEntry[];
  total_additions: number;
  total_deletions: number;
}
export interface PrListArgs {
  head?: string;
  base?: string;
  state: 'open' | 'closed' | 'merged' | 'all';
  author?: string;
  limit: number;
  repo?: string;
}

export interface NormalizedPr {
  number: number;
  title: string;
  state: string;
  head: string;
  base: string;
  url: string;
}

export interface PrListResponse {
  prs: NormalizedPr[];
}
export interface PrWaitCiArgs {
  number: number;
  poll_interval_sec: number;
  timeout_sec: number;
  repo?: string;
  /**
   * How long to keep re-probing an empty rollup / absent pipeline before
   * concluding the repo has no checks for this ref (#508). Not a CI timeout —
   * once one check registers, `timeout_sec` governs from there. `0` disables
   * the window and restores #416's t=0 behaviour; only tests should do that.
   */
  settle_window_sec?: number;
}

export type PrWaitCiFinalState = 'passed' | 'failed' | 'timed_out';

export interface PrWaitCiChecks {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  summary: string;
}

/**
 * Polling-loop return shape — the original `pr_wait_ci` response from before
 * #416. Reached when the PR has at least one configured check; the adapter
 * polls until every check is settled (or timeout).
 */
export interface PrWaitCiPolledResponse {
  number: number;
  final_state: PrWaitCiFinalState;
  checks: PrWaitCiChecks;
  waited_sec: number;
  url: string;
}

/**
 * The two ways "this PR has no checks" can be true (#508). They are different
 * facts and only one of them is safe, which is why they are different tokens.
 *
 * - `no_checks_configured` — the settle window elapsed and nothing indicates CI
 *   is coming. The repo genuinely runs no checks for this ref.
 * - `no_checks_yet` — the settle window elapsed but a CI run EXISTS for the head
 *   SHA that has not registered as a check. Checks are coming; we ran out of
 *   patience, not out of CI. **Never merge on this.**
 *
 * Replaces the single `no_checks_required` of #416, which meant both. That token
 * is deliberately gone rather than aliased: its plain-English name reads as
 * "nothing is wrong" (`skills/mmr/SKILL.md` calls it "a trap" in as many words),
 * and keeping it as a synonym would preserve exactly the ambiguity this fixes.
 * Callers that allowlist on `passed` are unaffected; anything matching the old
 * literal now fails to match, which is the intended forcing function.
 */
export type PrWaitCiNoChecksStatus = 'no_checks_configured' | 'no_checks_yet';

/**
 * Short-circuit return shape (#416, reworked by #508). Reached when the PR's
 * status-check rollup is still empty after the settle window.
 *
 * #416 returned this at t=0 on the first empty rollup. That is indistinguishable
 * from a check that is merely QUEUED — the rollup is empty in both cases — so a
 * PR whose CI had not yet started reported a definite, successful-sounding
 * verdict with `elapsed_sec: 0`. `mergeable` and an optional `blocker`
 * distinguish the happy path from the obstructed one (draft / conflicts / closed).
 */
export interface PrWaitCiNoChecksResponse {
  number: number;
  status: PrWaitCiNoChecksStatus;
  elapsed_sec: number;
  mergeable: boolean;
  /** Reason the PR is not mergeable today (e.g. `draft`, `conflicts`, `closed`). Omitted when mergeable. */
  blocker?: string;
  url: string;
  /** Seconds spent waiting for checks to register before concluding. 0 only when a hard blocker made waiting pointless. */
  settled_sec: number;
  /** Present on `no_checks_yet`: the un-registered runs that prove CI is coming. */
  pending_runs?: { run_id: number; workflow_name: string; status: string }[];
}

export type PrWaitCiResponse = PrWaitCiPolledResponse | PrWaitCiNoChecksResponse;

export type CiWaitRunArgs = unknown;
export type CiWaitRunResponse = unknown;

/**
 * Hybrid sub-call (Story 2.19, #313). `ciListRuns` is the slim per-ref CI-run
 * lister used by `ci_wait_run`'s polling loop and the merge-result
 * pre-flight. Narrower than `ciRunsForBranch` (which returns the full
 * `CiRunsForBranchRun[]` for a branch only, and never exposes `event`); this
 * call returns the shape the wait loop actually needs: `event` (for
 * the merge-result discriminator, #476) and `head_sha` (for the expected_sha anchor).
 *
 * GitLab pipelines don't carry a trigger-event in the way GitHub Actions runs
 * `event` carries GitLab's pipeline `source`. `head_sha` is populated on both
 * platforms.
 *
 * `workflow_name` / `expected_sha` filter behavior mirrors the pre-migration
 * handler: GitHub pushes both into the argv (`--workflow`, `--commit`) so the
 * server narrows; GitLab pushes `expected_sha` as `?sha=` and filters
 * `workflow_name` client-side against `source`.
 */
export interface CiListRunsArgs {
  ref: string;
  workflow_name?: string;
  repo?: string;
  expected_sha?: string;
  limit: number;
}

export interface NormalizedCiRun {
  run_id: number;
  workflow_name: string;
  /** Raw platform status — GitHub `queued | in_progress | completed | …`; GitLab `created | running | success | …`. Consumers that need a normalized status should go through `ciRunStatus`. */
  status: string;
  /** Raw platform conclusion or `null` when still running. Same caveat as `status`. */
  conclusion: string | null;
  url: string;
  head_sha: string;
  head_branch: string | null;
  created_at: string | null;
  /**
   * The run's trigger event — the field that distinguishes a MERGE-RESULT run
   * from a plain BRANCH run (#476).
   *
   * - GitHub: workflow event (`push | pull_request | schedule | …`). A
   *   `pull_request` run is evaluated against `refs/pull/N/merge` — the merge
   *   result — whereas a `push` run is evaluated against the branch HEAD.
   * - GitLab: the pipeline's `source` (`push | merge_request_event | web | …`).
   *   `merge_request_event` is a merged-results pipeline (CI against the result
   *   of merging source into target); `push` is a branch pipeline.
   *
   * `null` only when the platform genuinely did not report one.
   */
  event: string | null;
}

export type CiListRunsResponse = NormalizedCiRun[];


/**
 * Args for `resolveMergeAnchor` — the POSITIVE binding between the run the wave
 * trust gate grades and the commit actually under test (#476).
 */
export interface ResolveMergeAnchorArgs {
  /** PR (GitHub) / MR iid (GitLab). */
  number: number;
  repo?: string;
}

/**
 * The anchor. Filtering CI runs to "merge-result" runs is necessary but NOT
 * sufficient: nothing in a run list binds a run to the CURRENT head. Push commit
 * A (green), push commit B, and B's merge-result pipeline may not exist yet — the
 * newest merge-result run is still A's green one. Grading it merges code CI never
 * saw. Each platform states the binding differently:
 *
 * - GitHub: a `pull_request` run's `head_sha` IS the PR head SHA (verified on a
 *   live PR — it is NOT the ephemeral merge commit; that is a GitLab-only fact).
 *   So the anchor is the PR head SHA, matched against `run.head_sha`.
 * - GitLab: a merged-results pipeline's `sha` is the ephemeral merge commit, so a
 *   SHA match is impossible. GitLab instead publishes `mr.head_pipeline` — its own
 *   statement of "the pipeline for this MR's current head". The anchor is that id.
 *
 * Absence of an anchor must HOLD, never pass. Freshness has to be PROVEN.
 */
export interface MergeAnchor {
  /** GitHub: the PR head SHA a merge-result run must report. */
  head_sha?: string;
  /** GitLab: the id of the pipeline GitLab considers current for this MR. */
  head_pipeline_id?: number;
}

/**
 * Hybrid sub-call (Story 2.19, #313). `resolveBranchSha` collapses the
 * `fetchBranchToSha` helper lifted from the pre-migration `ci_wait_run`
 * handler. Returns `{ sha }` on success or `null` when the ref cannot be
 * resolved. On GitLab the concept doesn't apply (pipelines attach to branch
 * names directly); GitLab returns `platform_unsupported` with a hint.
 */
export interface ResolveBranchShaArgs {
  branch: string;
  repo?: string;
}

export interface ResolveBranchShaResponse {
  sha: string;
}

/**
 * `ci_run_status` args/response (Story 2.13, #307). Full-migration of the
 * latest-run lookup for a commit SHA or branch ref, optionally filtered by
 * workflow name.
 *
 * Two-step dispatch diverges per platform:
 * - GitHub: `gh run list [--commit <sha> | --branch <ref>] [--workflow <name>]
 *   [--repo <slug>] --limit 1 --json databaseId,name,status,conclusion,url,...`
 * - GitLab: `glab api projects/:id/pipelines?ref=<ref>[&per_page=<n>]` —
 *   `workflow_name` filtering happens client-side against the `source` field
 *   (GitLab pipelines don't carry a workflow name the way GitHub runs do).
 *
 * The normalized response (`NormalizedRun | null`) collapses the two very
 * different platform-native shapes onto a single enum-normalized record.
 * Status/conclusion enum mapping (both `normalizeGh*` and `normalizeGl*`)
 * belongs with each platform adapter — it's platform-shape-to-normalized-shape
 * glue, not handler business logic.
 *
 * `null` means "no matching run found" — the handler translates this into the
 * `{ok: false, code: 'no_runs_found'}` envelope.
 */
export interface CiRunStatusArgs {
  ref: string;
  workflow_name?: string;
  repo?: string;
}

export type CiRunStatus = 'queued' | 'in_progress' | 'completed';

export type CiRunConclusion =
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'skipped'
  | 'timed_out';

export interface NormalizedRun {
  run_id: number;
  workflow_name: string;
  status: CiRunStatus;
  conclusion: CiRunConclusion | null;
  url: string;
  ref: string;
  sha: string;
  created_at: string;
  finished_at: string | null;
}

export type CiRunStatusResponse = NormalizedRun | null;

/**
 * `ci_run_logs` args/response (Story 2.12, #306). Full-migration of log
 * retrieval for a CI run (GitHub workflow run) or pipeline job (GitLab).
 *
 * Two-step dispatch diverges per platform:
 * - GitHub: `gh run view <run_id> [--job <job_id>] --log | --log-failed
 *   [--repo <slug>]` — single subprocess call, returns concatenated log text.
 * - GitLab: when `job_id` is omitted, first resolves the failed job via
 *   `glab api projects/:id/pipelines/<run_id>/jobs`, then `glab ci trace
 *   <job_id> [-R <slug>]` to fetch the trace text.
 *
 * Adapter returns the RAW log string. Truncation is a platform-agnostic
 * post-step owned by the handler (`lib/shared/truncate-logs.ts`).
 *
 * `job_id` in the response reflects the job actually traced: on GitHub it
 * mirrors the caller's `job_id` (or `null` when omitted — full-run logs);
 * on GitLab it's always populated (either the caller's explicit id or the
 * pipeline-resolved failed job id).
 */
export interface CiRunLogsArgs {
  run_id: number;
  job_id?: number;
  failed_only: boolean;
  repo?: string;
}

export interface CiRunLogsResponse {
  logs: string;
  job_id: number | null;
  url: string;
}

/**
 * `ci_failed_jobs` args/response (Story 2.11, #305). Thin platform wrapper
 * around `gh run view --json jobs` / `glab api projects/:id/pipelines/<id>/jobs`
 * with identical `FailedJob[]` normalization on both sides.
 *
 * `run_id` is a positive integer — on GitHub it's the workflow run id,
 * on GitLab the pipeline id.
 */
export interface CiFailedJobsArgs {
  run_id: number;
  repo?: string;
}

export interface FailedJob {
  job_id: number;
  name: string;
  stage: string | null;
  conclusion: string;
  started_at: string | null;
  finished_at: string | null;
  url: string;
}

export interface CiFailedJobsResponse {
  failed_jobs: FailedJob[];
}

/**
 * `ci_runs_for_branch` args/response (Story 2.14, #308). Full-migration of
 * the recent-runs list for a branch, optionally filtered by status.
 *
 * The `status` vocabulary is the caller-facing enum
 * (`'success' | 'failure' | 'in_progress' | 'all'`) lifted verbatim from the
 * pre-migration handler; each platform adapter owns the translation to its
 * CLI's native flag value (`githubStatusFlag` / `gitlabStatusFlag`).
 *
 * Two-step dispatch diverges per platform:
 * - GitHub: `gh run list --branch <ref> --limit <n> [--status <flag>]
 *   [--repo <slug>] --json databaseId,name,status,conclusion,headSha,url,createdAt`.
 * - GitLab: `glab api projects/:id/pipelines?ref=<ref>&per_page=<n>` — GitLab
 *   has no server-side status filter, so the adapter fetches a larger window
 *   (`limit * 3`) and filters client-side against the platform-native
 *   `success | failed | running` vocabulary.
 *
 * The normalized `RunRecord` shape is the pre-migration struct — platform
 * status strings pass through unchanged (GitHub returns `completed | in_progress | …`;
 * GitLab returns `success | failed | running | …`) to preserve backward
 * compatibility with consumers of `ci_runs_for_branch`.
 */
export interface CiRunsForBranchArgs {
  branch: string;
  limit: number;
  status: 'success' | 'failure' | 'in_progress' | 'all';
  repo?: string;
}

export interface CiRunsForBranchRun {
  run_id: number;
  workflow_name: string;
  status: string;
  conclusion: string | null;
  sha: string;
  url: string;
  created_at: string;
}

export interface CiRunsForBranchResponse {
  runs: CiRunsForBranchRun[];
}

/**
 * `label_create` args/response (Story 2.15, #309). Full-migration of the
 * idempotent create-with-duplicate-lookup-fallback.
 *
 * Color asymmetry (per `lesson_origin_ops_pitfalls.md`):
 * - `args.color` is bare 6-char hex (no leading `#`) — validated at the
 *   handler schema level. Symmetric with the `gh label create --color` flag.
 * - GitLab's REST API requires `#RRGGBB`; the `label-create-gitlab.ts` adapter
 *   prepends the `#` on hand-off and strips it from the lookup payload so
 *   consumers always see bare hex.
 *
 * `NormalizedLabel.created` discriminates the new-create path (`true`) from
 * the idempotent-duplicate path (`false`, values reflect the pre-existing
 * label on disk rather than what the caller asked for).
 */
export interface LabelCreateArgs {
  name: string;
  color?: string;
  description?: string;
  repo?: string;
}

export interface NormalizedLabel {
  name: string;
  description: string;
  color: string;
  created: boolean;
}

export type LabelCreateResponse = NormalizedLabel;

/**
 * `label_list` args/response (Story 2.16, #310). Full-migration of the simplest
 * Origin Operations handler — list labels with limit and optional cross-repo
 * slug.
 *
 * Color contract is symmetric across platforms at the adapter boundary:
 * consumers always see bare 6-char hex (no leading `#`). The GitLab adapter
 * strips the leading `#` that `glab label list` returns; the GitHub adapter
 * passes gh's bare-hex output through unchanged. See
 * `lesson_origin_ops_pitfalls.md` for the argv-level asymmetry
 * (`--limit`/`--repo` on gh vs. `--per-page`/`-R` on glab).
 *
 * The `NormalizedLabelListEntry` shape deliberately omits `created` — that
 * field is the discriminator used by `label_create`'s idempotent path. A
 * simple `list` call has no such signal.
 */
export interface LabelListArgs {
  limit: number;
  repo?: string;
}

export interface NormalizedLabelListEntry {
  name: string;
  description: string;
  color: string;
}

export interface LabelListResponse {
  labels: NormalizedLabelListEntry[];
  count: number;
}
/**
 * `work_item` args/response (Story 2.17, #311). Full-migration of the
 * multi-shape "create an issue OR PR/MR" handler.
 *
 * `type` drives the sub-command an adapter picks:
 *   - issue types (`epic | story | bug | chore | doc | feature | fix`) →
 *     `gh issue create` / `glab issue create`
 *   - `pr` → `gh pr create` (GitHub)    | GitLab returns `platform_unsupported`
 *   - `mr` → `glab mr create` (GitLab)  | GitHub returns `platform_unsupported`
 *
 * The cross-platform asymmetry (PR on GitLab / MR on GitHub) is the typed
 * `platform_unsupported` signal per R-03 / #281. Before this migration, the
 * handler dispatched to the wrong platform's create fn on those inputs — e.g.
 * `createGithubPR` ran on a GitLab repo for `type:'pr'`. The adapter boundary
 * collapses dispatch into one method so the handler never branches on type
 * OR platform.
 *
 * `head_branch`, `base_branch`, `draft` are PR/MR-only and silently ignored on
 * issue types (matches pre-migration behavior — those fields are schema-opt).
 * `labels` apply to both issue and PR/MR creation, with `type::<name>` auto-
 * merged for issue types only (PRs/MRs do not receive auto type labels — they
 * carry `size::*` / `priority::*` etc. via the caller's explicit labels list).
 */
export type WorkItemType =
  | 'plan'
  | 'epic'
  | 'story'
  | 'feature'
  | 'bug'
  | 'chore'
  | 'doc'
  | 'fix'
  | 'pr'
  | 'mr';

export interface WorkItemArgs {
  type: WorkItemType;
  title: string;
  body?: string;
  labels?: string[];
  head_branch?: string;
  base_branch?: string;
  draft?: boolean;
  repo?: string;
}

export interface WorkItemResponse {
  url: string;
  number: number;
}

/**
 * `work_item_update` args/response (#287). Update an existing GitHub issue or
 * GitLab issue via the appropriate platform CLI.
 *
 * `issue_ref` is parsed by `parseIssueRef` (`#N` or `owner/repo#N`). Adapters
 * use the parsed `(owner, repo, number)` triple plus an optional `repo` arg
 * to compose the cross-repo `--repo` / `-R` flag.
 *
 * `patch` is a partial mutation:
 *   - `title` — replace the title
 *   - `body` — replace the FULL body
 *   - `body_section` — replace ONE H2 section (the H2 heading is matched after
 *      `normalizeHeading`); preserves all other sections verbatim. Mutually
 *      exclusive with `body` (handler validates and rejects with both).
 *   - `labels` — replace the FULL label set on the issue
 *   - `assignees` — replace the FULL assignee set
 *   - `milestone` — set the milestone (GitHub only; on GitLab the adapter
 *      returns `platform_unsupported`).
 *
 * `dry_run` returns the proposed patch without invoking the platform CLI.
 *
 * Cross-platform asymmetry (R-03):
 *   - `milestone` is a GitHub concept (`gh issue edit --milestone`). GitLab's
 *     equivalent is "milestone" too, BUT the work-item-update adapter on
 *     GitLab returns `platform_unsupported` for `milestone` because GitLab's
 *     `glab issue update --milestone` requires the milestone *id* and group/
 *     project resolution that this thin tool does not own. Callers needing
 *     GitLab milestone updates should call `glab` directly today.
 */
export interface WorkItemUpdatePatch {
  title?: string;
  body?: string;
  body_section?: { heading: string; content: string };
  labels?: string[];
  assignees?: string[];
  milestone?: string;
}

export interface WorkItemUpdateArgs {
  issue_ref: string;
  patch: WorkItemUpdatePatch;
  dry_run?: boolean;
  repo?: string;
}

export interface WorkItemUpdateResponse {
  url: string;
  number: number;
  /** True when this call was a dry-run; no platform CLI was invoked. */
  dry_run: boolean;
  /** The fields that were (or would be) updated. */
  updated_fields: string[];
  /** When `body_section` was used, the resulting full body (recomputed). */
  resolved_body?: string;
}

export type IbmArgs = unknown;
export type IbmResponse = unknown;
export type EpicSubIssuesArgs = unknown;
export type EpicSubIssuesResponse = unknown;

export type SpecGetArgs = unknown;
export type SpecGetResponse = unknown;
export type SpecValidateStructureArgs = unknown;
export type SpecValidateStructureResponse = unknown;
export type SpecAcceptanceCriteriaArgs = unknown;
export type SpecAcceptanceCriteriaResponse = unknown;
export type SpecDependenciesArgs = unknown;
export type SpecDependenciesResponse = unknown;

// Hybrid sub-call (Story 2.1, #295). `fetchIssue` is the single widest-reach
// platform operation in the retrofit — consumed by 10 downstream handlers
// (`ibm`, `spec_get`, `spec_validate_structure`, `spec_acceptance_criteria`,
// `spec_dependencies`, `epic_sub_issues`, `wave_compute`,
// `wave_dependency_graph`, `wave_topology`, `dod_load_manifest`). Returns the
// normalized intersection of fields those consumers read: number, title,
// state, url, body, labels. State is normalized to `OPEN | CLOSED` across
// both platforms (GitHub returns `OPEN/CLOSED`; GitLab returns
// `opened/closed`).
//
// Story 1.11 added the FIRST hybrid sub-call: `fetchPrState` — see
// `FetchPrStateArgs` / `PrStateInfo` above. Used by `prMergeWait` and the
// per-platform `prMerge` adapters.
export interface FetchIssueArgs {
  number: number;
  repo?: string;
}

export type IssueState = 'OPEN' | 'CLOSED';

export interface AdapterIssue {
  number: number;
  title: string;
  state: IssueState;
  url: string;
  body: string;
  labels: string[];
}

/**
 * Back-compat alias for downstream handler migrations that consume the
 * normalized issue record. Keeps the name `IssueData` live while the new
 * `AdapterIssue` name (matches the `AdapterResult<T>` / `PrStateInfo`
 * convention) becomes the preferred import.
 */
export type IssueData = AdapterIssue;

// Hybrid sub-call (Story 2.18, #312). `fetchPrForBranch` is the `ibm`
// keystone sub-call: find the open PR/MR for a given source branch. Narrower
// than `prList` (which returns the full normalized PR record for N items);
// this returns just `{ url, number }` or `null` when no match exists. The
// existing `ibm` handler used this shape via local `getGithubPrUrl` /
// `getGitlabMrUrl` helpers — this call lifts them onto the platform adapter
// so the handler becomes a thin dispatcher with zero platform branching.
//
// Default state semantics: `'open'` matches the pre-migration `ibm`
// behavior (gh pr list defaults to open; gitlab was filter-free but only the
// open-PR case was surfaced in the handler's response).
export interface FetchPrForBranchArgs {
  branch: string;
  state?: 'open' | 'closed' | 'merged' | 'all';
  repo?: string;
}

export interface PrForBranchRef {
  url: string;
  number: number;
}

/**
 * Hybrid sub-call (Story 2.20, #314). `fetchIssueClosure` collapses the
 * platform-branching `queryIssueClosure` helper lifted from the pre-migration
 * `wave_previous_merged` handler. Returns the narrow `(state,
 * closedByMergedPR)` pair that drives the wave-completion contract check —
 * does NOT return the full issue body/labels like `fetchIssue` does.
 *
 * GitHub uses a GraphQL query against `closedByPullRequestsReferences` and
 * `timelineItems[ClosedEvent]` (body-keyword closures like `Closes #N` are
 * missed by the REST events API — #183). GitLab stays on the state-only
 * interpretation: CLOSED implies merged. GitLab's commit-trailer style
 * populates closer info through a different code path and the #183 repro was
 * GitHub-specific.
 */
export interface FetchIssueClosureArgs {
  number: number;
  repo?: string;
}

export interface IssueClosureInfo {
  state: 'OPEN' | 'CLOSED';
  closedByMergedPR: boolean;
}

/**
 * Hybrid sub-call (Story 2.23, #317). `findExistingPr` is the `wave_finalize`
 * idempotency sub-call lifted from the handler-local `findExistingGithubPr`
 * / `findExistingGitlabMr` helpers. Returns the narrow `NormalizedPr` shape
 * (number, url, state, head, base, title) for the first PR/MR matching
 * `(head, base, state)` — or `null` when no match exists.
 *
 * Narrower than `prList` (which the caller is free to use when it needs more
 * than one entry at a time). `wave_finalize` only needs the first match;
 * this sub-call makes that intent explicit and keeps the handler free of
 * direct `gh pr list` / `glab api merge_requests` calls.
 *
 * `state` is REQUIRED here — unlike `fetchPrForBranch` which defaults to
 * `'open'`. Callers that probe merged/closed PRs must state that intent
 * explicitly so the semantics of `null` (no PR in the requested state) stay
 * sharp.
 */
export interface FindExistingPrArgs {
  head: string;
  base: string;
  state: 'open' | 'closed' | 'merged';
  repo?: string;
  /** Working directory for the gh|glab invocation; defaults to CLAUDE_PROJECT_DIR ?? process.cwd(). */
  cwd?: string;
}

/**
 * Hybrid sub-call (Story 2.22, #316). `createBranch` is the KAHUNA bootstrap
 * sub-call lifted from `handlers/wave_init.ts`'s local `createKahunaBranch`
 * helper. Creates a branch pointing at an explicit SHA.
 *
 * Two-step dispatch diverges per platform:
 * - GitHub: `gh api repos/:owner/:repo/git/refs -X POST -f ref=refs/heads/<name>
 *   -f sha=<sha>`. `gh api` resolves repo context from the URL path — no
 *   `--repo` flag (that belongs to porcelain subcommands like `gh pr …`).
 * - GitLab: `glab api projects/:id/repository/branches -X POST -f branch=<name>
 *   -f ref=<sha>`. The `:id` slug is `%2F`-encoded from `owner/repo`.
 *
 * Returns `void` on success (the response body is just an echo of the ref
 * with no fields the handler needs). On failure returns `{ok: false, …}`;
 * there's no "already exists" idempotent path — the handler's state/remote
 * pre-check catches that case before we get here.
 */
export interface CreateBranchArgs {
  branch: string;
  sha: string;
  repo?: string;
}

/**
 * Hybrid sub-call (Story 2.21, #315). `findMergedPrForBranchPrefix` collapses
 * the handler-local `queryGithubMergedPrs` / `queryGitlabMergedMrs` helpers
 * lifted from the pre-migration `wave_reconcile_mrs` handler. Returns the
 * first merged PR/MR whose source branch starts with `prefix`, or `null` when
 * no merged PR/MR matches.
 *
 * Narrower than `prList`: the reconcile flow only needs a single URL, and
 * `prList` does not support the prefix-match semantics (it filters on an
 * exact `--head` branch). The scan is strictly client-side — the platform
 * CLIs do not expose a server-side `branch-prefix` filter.
 *
 * `limit` caps the merged-list window scanned client-side. The pre-migration
 * handler hardcoded 50 (bug #282) — the adapter exposes it as an arg with a
 * default of 100 so callers can widen the window when a wave contains more
 * than 50 merged PRs. GitLab has no native `--limit`; the adapter feeds
 * `limit` into `per_page`.
 */
export interface FindMergedPrForBranchPrefixArgs {
  prefix: string;
  limit?: number;
  repo?: string;
}

/**
 * Hybrid sub-call (Story 2.24, #318 — FINAL Phase 2 migration).
 * `fetchCiTrustSignal` is the narrow "does this platform guarantee
 * pre-merge CI == post-merge CI?" probe lifted from
 * `handlers/wave_ci_trust_level.ts`'s `checkGithubTrust` / `checkGitlabTrust`
 * helpers.
 *
 * Returns the narrow `(level, reason)` pair that drives the trust-level
 * classification — the trust-level cache and TTL stay in the handler (the
 * adapter is the cache-miss path). Consumed ONLY by `wave_ci_trust_level`;
 * this sub-call is narrower than any of the other CI-family methods because
 * it probes repo-level settings (rulesets, branch protection,
 * `merge_trains_enabled`) rather than per-run / per-PR state.
 *
 * Two-step dispatch diverges per platform:
 * - GitHub: `gh api repos/<slug>/rulesets` is queried first (merge queue
 *   lives in a ruleset); on cache miss the adapter falls back to
 *   `gh api repos/<slug>/branches/<default>/protection` — the LIVE default
 *   branch resolved via `resolveDefaultBranch` (never hardcoded 'main', #472) —
 *   and checks the `required_status_checks.strict` flag.
 * - GitLab: `glab api projects/<path>` via `gitlabApiRepo()` (imported from
 *   `lib/gitlab-api.ts`); `merge_trains_enabled` is the lone
 *   pre-merge-authoritative signal — merge pipelines alone are not sufficient
 *   (they still allow merge before CI completes).
 *
 * Failure modes (subprocess error, JSON parse error, unrecognized platform)
 * collapse to `level: 'unknown'` at the HANDLER level — the adapter itself
 * returns `{ok: false, …}` for subprocess failures and the handler folds
 * that into the classification envelope.
 */
export type CiTrustLevel =
  | 'pre_merge_authoritative'
  | 'post_merge_required'
  | 'unknown';

export interface FetchCiTrustSignalArgs {
  repo?: string;
}

export interface CiTrustSignal {
  level: CiTrustLevel;
  reason: string;
}

/**
 * `branch_guard` live default-branch query (#465, #470).
 *
 * `resolveDefaultBranch` promotes the private `getDefaultBranch()` helper that
 * both `pr-create-{github,gitlab}.ts` carried (GitHub:
 * `gh repo view --json defaultBranchRef`; GitLab: `glab api projects/:id` →
 * `default_branch`) into a shared method — removing the duplication and giving
 * `branch_guard` a LIVE default-branch source (never `origin/HEAD`, never a
 * cached `.claude-project.md` value).
 *
 * Note (#470): there is deliberately NO host protection query here. Whether a
 * branch is "protected" is a NAME convention (`main` | `release/*`) resolved in
 * `handlers/branch_guard.ts` via the shared `PROTECTED_BRANCH_PATTERN`, not an
 * adapter call — no admin permission, no rate-limit / fail-closed risk.
 */
export interface ResolveDefaultBranchArgs {
  repo?: string;
  /** Working directory for the gh|glab invocation; defaults to CLAUDE_PROJECT_DIR ?? process.cwd(). */
  cwd?: string;
}

export interface ResolveDefaultBranchResponse {
  default_branch: string;
}

// ---------------------------------------------------------------------------
// The interface
// ---------------------------------------------------------------------------

export interface PlatformAdapter {
  // PR/MR family (Stories 1.3 – 1.11)
  prCreate(args: PrCreateArgs): Promise<AdapterResult<PrCreateResponse>>;
  prMerge(args: PrMergeArgs): Promise<AdapterResult<PrMergeResponse>>;
  prMergeWait(args: PrMergeWaitArgs): Promise<AdapterResult<PrMergeWaitResponse>>;
  prStatus(args: PrStatusArgs): Promise<AdapterResult<PrStatusResponse>>;
  prDiff(args: PrDiffArgs): Promise<AdapterResult<PrDiffResponse>>;
  prComment(args: PrCommentArgs): Promise<AdapterResult<PrCommentResponse>>;
  prFiles(args: PrFilesArgs): Promise<AdapterResult<PrFilesResponse>>;
  prList(args: PrListArgs): Promise<AdapterResult<PrListResponse>>;
  prWaitCi(args: PrWaitCiArgs): Promise<AdapterResult<PrWaitCiResponse>>;

  // CI family
  ciWaitRun(args: CiWaitRunArgs): Promise<AdapterResult<CiWaitRunResponse>>;
  ciRunStatus(args: CiRunStatusArgs): Promise<AdapterResult<CiRunStatusResponse>>;
  ciRunLogs(args: CiRunLogsArgs): Promise<AdapterResult<CiRunLogsResponse>>;
  ciFailedJobs(args: CiFailedJobsArgs): Promise<AdapterResult<CiFailedJobsResponse>>;
  ciRunsForBranch(args: CiRunsForBranchArgs): Promise<AdapterResult<CiRunsForBranchResponse>>;

  // Label & issue CRUD
  labelCreate(args: LabelCreateArgs): Promise<AdapterResult<NormalizedLabel>>;
  labelList(args: LabelListArgs): Promise<AdapterResult<LabelListResponse>>;
  workItem(args: WorkItemArgs): Promise<AdapterResult<WorkItemResponse>>;
  workItemUpdate(
    args: WorkItemUpdateArgs,
  ): Promise<AdapterResult<WorkItemUpdateResponse>>;
  ibm(args: IbmArgs): Promise<AdapterResult<IbmResponse>>;
  epicSubIssues(args: EpicSubIssuesArgs): Promise<AdapterResult<EpicSubIssuesResponse>>;

  // Spec operations
  specGet(args: SpecGetArgs): Promise<AdapterResult<SpecGetResponse>>;
  specValidateStructure(args: SpecValidateStructureArgs): Promise<AdapterResult<SpecValidateStructureResponse>>;
  specAcceptanceCriteria(args: SpecAcceptanceCriteriaArgs): Promise<AdapterResult<SpecAcceptanceCriteriaResponse>>;
  specDependencies(args: SpecDependenciesArgs): Promise<AdapterResult<SpecDependenciesResponse>>;

  // Hybrid sub-calls.
  // `fetchPrState` is the first real hybrid (Story 1.11) — consumed by
  // `prMergeWait` and the per-platform `prMerge` adapters for state polling
  // and post-merge URL/sha lookup.
  // `fetchIssue` (Story 2.1) is the keystone sub-call for Phase 2 — consumed
  // by 10 handlers that all read the same normalized issue shape.
  // `ciListRuns` + `resolveBranchSha` (Story 2.19) are the `ci_wait_run`
  // keystone sub-calls — consumed by the polling loop in
  // `lib/ci-wait-run-poll.ts` and the merge-result discriminator (#476).
  fetchIssue(args: FetchIssueArgs): Promise<AdapterResult<AdapterIssue>>;
  fetchPrState(args: FetchPrStateArgs): Promise<AdapterResult<PrStateInfo>>;
  fetchPrForBranch(
    args: FetchPrForBranchArgs,
  ): Promise<AdapterResult<PrForBranchRef | null>>;
  fetchIssueClosure(
    args: FetchIssueClosureArgs,
  ): Promise<AdapterResult<IssueClosureInfo>>;
  findMergedPrForBranchPrefix(
    args: FindMergedPrForBranchPrefixArgs,
  ): Promise<AdapterResult<{ url: string } | null>>;
  ciListRuns(
    args: CiListRunsArgs,
  ): Promise<AdapterResult<CiListRunsResponse>>;
  resolveBranchSha(
    args: ResolveBranchShaArgs,
  ): Promise<AdapterResult<ResolveBranchShaResponse | null>>;
  /** #476 — the freshness anchor for the wave trust gate. See MergeAnchor. */
  resolveMergeAnchor(
    args: ResolveMergeAnchorArgs,
  ): Promise<AdapterResult<MergeAnchor>>;
  createBranch(args: CreateBranchArgs): Promise<AdapterResult<void>>;
  findExistingPr(
    args: FindExistingPrArgs,
  ): Promise<AdapterResult<NormalizedPr | null>>;
  fetchCiTrustSignal(
    args: FetchCiTrustSignalArgs,
  ): Promise<AdapterResult<CiTrustSignal>>;

  // branch_guard live default-branch query (#465, #470).
  resolveDefaultBranch(
    args: ResolveDefaultBranchArgs,
  ): Promise<AdapterResult<ResolveDefaultBranchResponse>>;
}

// ---------------------------------------------------------------------------
// Runtime method-name registry (powers the contract test, R-04)
//
// The interface above is erased at runtime; the test in `types.test.ts` uses
// this constant to assert each adapter object exposes a function for every
// listed method. Drift between this list and `PlatformAdapter` is caught at
// compile time by the assertion below.
// ---------------------------------------------------------------------------

export const PLATFORM_ADAPTER_METHODS = [
  'prCreate',
  'prMerge',
  'prMergeWait',
  'prStatus',
  'prDiff',
  'prComment',
  'prFiles',
  'prList',
  'prWaitCi',
  'ciWaitRun',
  'ciRunStatus',
  'ciRunLogs',
  'ciFailedJobs',
  'ciRunsForBranch',
  'labelCreate',
  'labelList',
  'workItem',
  'workItemUpdate',
  'ibm',
  'epicSubIssues',
  'specGet',
  'specValidateStructure',
  'specAcceptanceCriteria',
  'specDependencies',
  'fetchIssue',
  'fetchPrState',
  'fetchPrForBranch',
  'fetchIssueClosure',
  'findMergedPrForBranchPrefix',
  'ciListRuns',
  'resolveBranchSha',
  'resolveMergeAnchor',
  'createBranch',
  'findExistingPr',
  'fetchCiTrustSignal',
  'resolveDefaultBranch',
] as const;

export type PlatformAdapterMethod = (typeof PLATFORM_ADAPTER_METHODS)[number];

// Compile-time check — catches methods added to `PlatformAdapter` without a
// corresponding entry in `PLATFORM_ADAPTER_METHODS` (one direction only). The
// reverse — extra entries in the list that don't match any interface key —
// is caught by the runtime contract test in `types.test.ts`: the adapter
// objects are typed as `: PlatformAdapter`, so they cannot carry an extra
// method, and the test's `typeof fn === 'function'` assertion fails.
type _MethodsExhaustive =
  keyof PlatformAdapter extends PlatformAdapterMethod
    ? true
    : { missingFromList: Exclude<keyof PlatformAdapter, PlatformAdapterMethod> };

const _methodsExhaustive: _MethodsExhaustive = true;
void _methodsExhaustive;
