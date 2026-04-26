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
export type PrMergeArgs = unknown;
export type PrMergeResponse = unknown;
export type PrMergeWaitArgs = unknown;
export type PrMergeWaitResponse = unknown;
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
export type PrWaitCiArgs = unknown;
export type PrWaitCiResponse = unknown;

export type CiWaitRunArgs = unknown;
export type CiWaitRunResponse = unknown;
export type CiRunStatusArgs = unknown;
export type CiRunStatusResponse = unknown;
export type CiRunLogsArgs = unknown;
export type CiRunLogsResponse = unknown;
export type CiFailedJobsArgs = unknown;
export type CiFailedJobsResponse = unknown;
export type CiRunsForBranchArgs = unknown;
export type CiRunsForBranchResponse = unknown;

export type LabelCreateArgs = unknown;
export type LabelCreateResponse = unknown;
export type LabelListArgs = unknown;
export type LabelListResponse = unknown;
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

// Hybrid sub-call placeholder (per §5.1, §5.5). The Phase 1 survey (Story
// 1.12) produces the authoritative list of hybrid sub-calls; `fetchIssue` is
// included here as the illustrative example. Adding/removing sub-calls is
// expected during Phase 2 implementation.
export type FetchIssueArgs = unknown;
export type IssueData = unknown;

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
  labelCreate(args: LabelCreateArgs): Promise<AdapterResult<LabelCreateResponse>>;
  labelList(args: LabelListArgs): Promise<AdapterResult<LabelListResponse>>;
  workItem(args: WorkItemArgs): Promise<AdapterResult<WorkItemResponse>>;
  ibm(args: IbmArgs): Promise<AdapterResult<IbmResponse>>;
  epicSubIssues(args: EpicSubIssuesArgs): Promise<AdapterResult<EpicSubIssuesResponse>>;

  // Spec operations
  specGet(args: SpecGetArgs): Promise<AdapterResult<SpecGetResponse>>;
  specValidateStructure(args: SpecValidateStructureArgs): Promise<AdapterResult<SpecValidateStructureResponse>>;
  specAcceptanceCriteria(args: SpecAcceptanceCriteriaArgs): Promise<AdapterResult<SpecAcceptanceCriteriaResponse>>;
  specDependencies(args: SpecDependenciesArgs): Promise<AdapterResult<SpecDependenciesResponse>>;

  // Hybrid sub-calls (illustrative; final set determined by Story 1.12 survey)
  fetchIssue(args: FetchIssueArgs): Promise<AdapterResult<IssueData>>;
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
