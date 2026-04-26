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
  | { ok: true; data: T }
  | { ok: false; error: string; code: string }
  | { platform_unsupported: true; hint: string };

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
}

export type PrMergeMethod = 'direct_squash' | 'merge_queue';
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
}
export interface PrMergeWaitArgs {
  number: number;
  squash_message?: string;
  use_merge_queue?: boolean;
  skip_train?: boolean;
  repo?: string;
  timeout_sec?: number;
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
}

export type PrWaitCiFinalState = 'passed' | 'failed' | 'timed_out';

export interface PrWaitCiChecks {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  summary: string;
}

export interface PrWaitCiResponse {
  number: number;
  final_state: PrWaitCiFinalState;
  checks: PrWaitCiChecks;
  waited_sec: number;
  url: string;
}

export type CiWaitRunArgs = unknown;
export type CiWaitRunResponse = unknown;

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
export type WorkItemArgs = unknown;
export type WorkItemResponse = unknown;
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
  fetchIssue(args: FetchIssueArgs): Promise<AdapterResult<AdapterIssue>>;
  fetchPrState(args: FetchPrStateArgs): Promise<AdapterResult<PrStateInfo>>;
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
  'ibm',
  'epicSubIssues',
  'specGet',
  'specValidateStructure',
  'specAcceptanceCriteria',
  'specDependencies',
  'fetchIssue',
  'fetchPrState',
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
