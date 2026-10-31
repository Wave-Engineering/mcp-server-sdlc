/**
 * Shared GitLab REST API (`glab api`) wrappers used by GitLab platform
 * adapters in `lib/adapters/*-gitlab.ts`.
 *
 * Strictly GitLab-specific: REST response types and typed wrappers around
 * `glab api projects/...` endpoints. `detectPlatform`, `detectPlatformForRef`,
 * and `parseRepoSlug` live in `lib/shared/` (Story 1.2, R-17).
 *
 * Why `glab api` and not `glab <sub> view --output json`:
 * `glab 1.36.0`, the documented floor, has no `--output`/`-F` flag on any view
 * or list subcommand (`issue view`, `label list`, `mr view`, `mr list`,
 * `ci list`, `repo view` all reject it). Later releases add it piecemeal:
 * `issue view` and `label list` in 1.37.0, `mr view` by 1.53.0. So no adapter
 * asks any of them for JSON, and the source-scan guard in
 * `tests/integration/cli-flag-shapes.test.ts` holds that (#383, #594).
 * `glab api` invokes the GitLab REST API v4 directly and returns native JSON.
 */

import { execSync } from 'child_process';
import { parseRepoSlug } from './shared/parse-repo-slug.js';
import { shellQuote } from './shared/shell-escape.js';

/**
 * URL-encoded project path suitable for `glab api projects/<path>/...`
 * endpoints. GitLab REST API v4 accepts either the numeric project ID or the
 * URL-encoded `owner/repo` slug (e.g. `owner%2Frepo`).
 *
 * Throws if the origin URL cannot be parsed. Callers that want a graceful
 * fallback should catch the error and fall through to the GitHub code path.
 */
export function gitlabProjectPath(cwd?: string): string {
  const slug = parseRepoSlug(cwd);
  if (!slug) throw new Error('could not parse gitlab project path from origin url');
  return encodeURIComponent(slug);
}

// ---------------------------------------------------------------------------
// Types — GitLab REST API v4 response shapes
// ---------------------------------------------------------------------------
//
// These interfaces mark the fields handlers currently consume as required and
// everything else as optional. The GitLab API returns many more fields than
// listed here — keeping the interface strict would force handlers to cast
// unnecessarily, so we lean permissive on fields that aren't load-bearing.

export interface GitlabLabel {
  id?: number;
  name: string;
  description?: string | null;
  color?: string;
}

export interface GitlabAssignee {
  id: number;
  username: string;
  name?: string;
  web_url?: string;
}

export interface GitlabIssue {
  id?: number;
  iid: number;
  project_id?: number;
  title: string;
  description: string | null;
  state: string; // 'opened' | 'closed'
  labels: string[];
  web_url: string;
  assignees?: GitlabAssignee[];
  author?: GitlabAssignee;
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
}

export interface GitlabMr {
  id?: number;
  iid: number;
  project_id?: number;
  title: string;
  description: string | null;
  state: string; // 'opened' | 'closed' | 'merged' | 'locked'
  source_branch: string;
  target_branch: string;
  web_url: string;
  labels: string[];
  assignees?: GitlabAssignee[];
  author?: GitlabAssignee;
  merge_status?: string;
  detailed_merge_status?: string;
  has_conflicts?: boolean;
  draft?: boolean;
  work_in_progress?: boolean;
  head_pipeline?: GitlabPipeline | null;
  pipeline?: GitlabPipeline | null; // Alias for head_pipeline in some contexts
  /**
   * Diff head SHA — the HEAD commit of the **source branch**. Distinct from
   * `merge_commit_sha`, which is the commit produced *by* a merge and is null
   * until the MR is merged. This is the value GitLab's merge endpoint wants as
   * its `sha` stale-head guard (#486).
   *
   * Read as the FALLBACK: `diff_refs.head_sha` below is the canonical source
   * and takes precedence (see `resolveHeadSha` in `pr-merge-gitlab.ts`).
   */
  sha?: string;
  /** Canonical source-branch head; preferred over the top-level `sha`. */
  diff_refs?: {
    base_sha?: string | null;
    head_sha?: string | null;
    start_sha?: string | null;
  } | null;
  merge_commit_sha?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface GitlabPipeline {
  id: number;
  iid?: number;
  project_id?: number;
  sha: string;
  ref: string;
  status: string; // 'created' | 'pending' | 'running' | 'success' | 'failed' | 'canceled' | 'skipped' | 'manual'
  source?: string;
  web_url: string;
  created_at?: string;
  updated_at?: string;
  started_at?: string | null;
  finished_at?: string | null;
}

export interface GitlabRepo {
  id: number;
  name: string;
  path: string;
  path_with_namespace: string;
  web_url: string;
  default_branch?: string;
  visibility?: string;
  merge_pipelines_enabled?: boolean;
  merge_trains_enabled?: boolean;
}

// ---------------------------------------------------------------------------
// Low-level exec wrapper
// ---------------------------------------------------------------------------

// Exported for test: the guards here are the whole point of #502/#382, and a
// test that only exercises the pure detector cannot tell whether this function
// still consults it — that mutation survived until this was reachable.
//
// ARGV, NEVER A SHELL STRING (#585). A list endpoint joins its query with `&`,
// which an unquoted shell string reads as the background operator:
// `glab api …/pipelines?ref=x&per_page=20` sent glab to the background, the
// shell exited at once, and stdout came back empty. #428's "empty output means
// no results" then made that an authoritative `[]`, so `ci_wait_run` could
// never see a GitLab pipeline. `encodeURIComponent` leaves `'()*!` alone too,
// so a branch like `fix/(x)` was a shell syntax error. Every token is quoted
// as needed, and the shell hands each one to glab intact. It stays on
// `execSync` rather than `execFileSync` because the shared test mock
// (`lib/test-support/mock-child-process.ts`) replaces only `execSync`.
export function execGlab(argv: string[], cwd?: string): string {
  const cmd = argv.map(shellQuote).join(' ');
  let raw: string;
  try {
    // `cwd` defaults to undefined, leaving execSync on `process.cwd()` —
    // identical to pre-#453 behavior for every existing caller. Callers that
    // thread an explicit cwd (e.g. find-existing-pr-gitlab via wave_finalize)
    // run `glab` in that directory so the API hits the right project.
    raw = execSync(cmd, {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 64,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
    });
  } catch (err) {
    if (err instanceof Error && ('stderr' in err || 'status' in err)) {
      const stderr = String((err as { stderr?: unknown }).stderr ?? '').trim();
      const status = (err as { status?: number }).status;
      const exit = typeof status === 'number' ? status : '?';
      throw new Error(
        `glab failed (exit ${exit}): ${cmd}${stderr ? `\nstderr: ${stderr}` : ''}`,
      );
    }
    throw err;
  }
  // Zero-exit-empty-stdout: caller would do JSON.parse('') → SyntaxError
  // ("Unexpected EOF") that loses the underlying cause. Surface a named
  // error instead so the failure is diagnosable. (#382)
  // Note: `[]` and `{}` are valid empty-collection responses (e.g. "no MRs
  // for this branch") — only truly empty output indicates a glab failure.
  if (raw.trim() === '') {
    throw new Error(`glab returned empty output for: ${cmd}`);
  }
  // HTTP ERRORS ARRIVE ON STDOUT WITH EXIT 0 (#502). `glab api` prints the API's
  // error body — `{"message":"404 Project Not Found"}` — and exits ZERO, so
  // neither guard above fires. The typed wrapper then JSON.parses it into its
  // expected shape, every field comes back `undefined`, and the handler emits a
  // confident `ok: true` envelope full of falsy data.
  //
  // That is a false negative that reads as an authoritative answer:
  // `spec_validate_structure` reported a perfectly valid issue as missing all
  // three required sections, with `ok: true`. The tool did not fail — it
  // answered, wrongly, and nothing downstream could tell.
  //
  // Detected HERE rather than in each wrapper because this is the chokepoint
  // every one of them routes through; fixing it per-wrapper is how #491's
  // knowledge stayed scoped to the wrong caller for months.
  const apiError = detectGlabApiError(raw);
  if (apiError !== undefined) {
    throw new Error(`glab API error for: ${cmd}\n${apiError}`);
  }
  return raw;
}

/**
 * GitLab's REST error body, if `raw` is one.
 *
 * The shape is `{"message": ...}` or `{"error": ...}` — and `message` may be a
 * string, an array, or an object keyed by field, so it is rendered rather than
 * assumed to be a string.
 *
 * Deliberately narrow: it must not mistake a legitimate payload that merely
 * HAS a `message` field for an error. A GitLab error body is a bare object with
 * no other content, so an object carrying `id`/`iid`/`web_url` alongside is a
 * real resource and passes through untouched.
 */
export function detectGlabApiError(raw: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined; // not JSON — not our business
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  const obj = parsed as Record<string, unknown>;
  const carrier = 'message' in obj ? 'message' : 'error' in obj ? 'error' : undefined;
  if (carrier === undefined) return undefined;
  // A real resource that happens to carry `message` (a commit, a note) also
  // carries identifying fields. An error body does not.
  for (const marker of ['id', 'iid', 'web_url', 'sha', 'name', 'path']) {
    if (marker in obj) return undefined;
  }
  const value = obj[carrier];
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * Build a URL-encoded project path, using explicit owner/repo if provided,
 * otherwise falling back to the current repo's slug.
 */
function projectPath(opts?: { owner?: string; repo?: string }, cwd?: string): string {
  if (opts && opts.owner && opts.repo) {
    return encodeURIComponent(`${opts.owner}/${opts.repo}`);
  }
  return gitlabProjectPath(cwd);
}

/**
 * The `{owner, repo}` opts for a caller-supplied slug, split at the LAST '/'.
 *
 * GitLab nests groups (`group/sub/project`; `repoOptionalSchema` accepts that
 * depth since #290). A two-way `split('/', 2)` kept `group/sub` and dropped the
 * rest, so an explicit `repo` queried the wrong project (#585).
 */
export function gitlabRepoOpts(slug: string | undefined): { owner: string; repo: string } | undefined {
  if (!slug) return undefined;
  const idx = slug.lastIndexOf('/');
  if (idx <= 0 || idx === slug.length - 1) return undefined;
  return { owner: slug.slice(0, idx), repo: slug.slice(idx + 1) };
}

/**
 * Parse a list endpoint's response. Anything but an array is a failed call.
 * `glab api` answers a list endpoint that matches nothing with `[]`, and
 * `execGlab` already throws on empty stdout, so there is no "no results"
 * path through here other than a real `[]` (#585).
 */
function parseList<T>(raw: string, endpoint: string): T[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    // Quoted, so the command in the message is safe to paste (#492, #585).
    throw new Error(`glab api ${shellQuote(endpoint)} returned a non-array`);
  }
  return parsed as T[];
}

// ---------------------------------------------------------------------------
// Typed wrappers — one per GitLab REST API endpoint handlers need
// ---------------------------------------------------------------------------

/**
 * Fetch a single issue by IID.
 *
 * Endpoint: `GET /projects/:id/issues/:issue_iid`
 *
 * Throws if the CLI invocation fails (non-zero exit). Callers should wrap in
 * try/catch and surface a structured error in their response.
 */
export function gitlabApiIssue(
  iid: number,
  opts?: { owner?: string; repo?: string },
): GitlabIssue {
  const path = projectPath(opts);
  const raw = execGlab(['glab', 'api', `projects/${path}/issues/${String(iid)}`]);
  return JSON.parse(raw) as GitlabIssue;
}

/**
 * Fetch a single merge request by IID.
 *
 * Endpoint: `GET /projects/:id/merge_requests/:merge_request_iid`
 */
export function gitlabApiMr(
  iid: number,
  opts?: { owner?: string; repo?: string },
): GitlabMr {
  const path = projectPath(opts);
  const raw = execGlab(['glab', 'api', `projects/${path}/merge_requests/${String(iid)}`]);
  return JSON.parse(raw) as GitlabMr;
}

/** One file entry from `GET /projects/:id/merge_requests/:iid/diffs`. */
export interface GitlabMrDiff {
  old_path?: string;
  new_path?: string;
  new_file?: boolean;
  renamed_file?: boolean;
  deleted_file?: boolean;
  diff?: string;
}

const MR_DIFFS_PER_PAGE = 100;
const MR_DIFFS_MAX_PAGES = 50;

/**
 * Fetch every file diff of a merge request, following pagination.
 *
 * Endpoint: `GET /projects/:id/merge_requests/:merge_request_iid/diffs`
 *
 * The single-MR endpoint (`gitlabApiMr`) carries only `changes_count`, never a
 * `changes[]` array — reading files from it silently yields none (#590,
 * live-verified). `/changes` has that array but is deprecated (GitLab 15.7),
 * so `/diffs` is the source for per-file paths, status flags and diff text.
 * Exceeding the page cap throws rather than returning a truncated list: a
 * partial file list is indistinguishable from a complete one to the caller.
 */
export function gitlabApiMrDiffs(
  iid: number,
  opts?: { owner?: string; repo?: string },
): GitlabMrDiff[] {
  const path = projectPath(opts);
  const all: GitlabMrDiff[] = [];
  for (let page = 1; page <= MR_DIFFS_MAX_PAGES; page++) {
    // Query params as `-f` fields on an explicit GET (glab appends them to the
    // URL). `--paginate` is not used — it concatenates pages as separate JSON
    // arrays (`[...][...]`), not one document.
    const raw = execGlab([
      'glab', 'api', `projects/${path}/merge_requests/${String(iid)}/diffs`,
      '-X', 'GET', '-f', `per_page=${String(MR_DIFFS_PER_PAGE)}`, '-f', `page=${String(page)}`,
    ]);
    const batch = JSON.parse(raw) as GitlabMrDiff[];
    if (!Array.isArray(batch)) {
      throw new Error(`glab api .../merge_requests/${String(iid)}/diffs returned a non-array`);
    }
    all.push(...batch);
    if (batch.length < MR_DIFFS_PER_PAGE) return all;
  }
  throw new Error(
    `merge request !${String(iid)} has more than ${String(MR_DIFFS_PER_PAGE * MR_DIFFS_MAX_PAGES)} changed files; refusing to return a truncated list`,
  );
}

export interface GitlabNote {
  id: number;
  body: string;
  created_at: string;
  system?: boolean;
}

const ISSUE_NOTES_PER_PAGE = 100;
const ISSUE_NOTES_MAX_PAGES = 50;

/**
 * List an issue's notes (comments), oldest first.
 *
 * Endpoint: `GET /projects/:id/issues/:issue_iid/notes`
 *
 * Pages the same way as `gitlabApiMrDiffs`, and for the same reason refuses to
 * return a truncated list: the entry-condition sync reads the LATEST state per
 * EC, so a missing last page could drop a `reclosed` and leave a stale `met`
 * standing (#613). System notes are returned; callers filter them.
 */
export function gitlabApiIssueNotes(
  iid: number,
  opts?: { owner?: string; repo?: string },
): GitlabNote[] {
  const path = projectPath(opts);
  const endpoint = `projects/${path}/issues/${String(iid)}/notes`;
  const all: GitlabNote[] = [];
  for (let page = 1; page <= ISSUE_NOTES_MAX_PAGES; page++) {
    const raw = execGlab([
      'glab', 'api', endpoint,
      '-X', 'GET',
      '-f', 'sort=asc', '-f', 'order_by=created_at',
      '-f', `per_page=${String(ISSUE_NOTES_PER_PAGE)}`, '-f', `page=${String(page)}`,
    ]);
    const batch = parseList<GitlabNote>(raw, endpoint);
    all.push(...batch);
    if (batch.length < ISSUE_NOTES_PER_PAGE) return all;
  }
  throw new Error(
    `issue #${String(iid)} has more than ${String(ISSUE_NOTES_PER_PAGE * ISSUE_NOTES_MAX_PAGES)} notes; refusing to return a truncated list`,
  );
}

/**
 * List merge requests with filters. Returns an array of `GitlabMr`.
 *
 * Endpoint: `GET /projects/:id/merge_requests?<query>`
 *
 * **State translation (GitLab REST API v4 conventions):**
 * - `'open'`   → `state=opened`
 * - `'closed'` → `state=closed`
 * - `'merged'` → `state=merged`
 * - `'all'`    → query param omitted entirely (returns all states)
 *
 * This is different from the glab CLI (`-c`/`-M`/`-A` boolean flags), and
 * different from the GitHub convention (`open`/`closed`/`merged`). The
 * mapping happens in this function so handlers can pass through their own
 * caller-facing `'open'/'closed'/'merged'/'all'` vocabulary unchanged.
 *
 * The `head`/`base`/`author`/`limit` params are optional; only provided
 * fields become query parameters.
 */
export function gitlabApiMrList(
  params: {
    head?: string;
    base?: string;
    state?: 'open' | 'closed' | 'merged' | 'all';
    author?: string;
    limit?: number;
  },
  opts?: { owner?: string; repo?: string },
  cwd?: string,
): GitlabMr[] {
  const path = projectPath(opts, cwd);
  const queryParts: string[] = [];

  // State translation: GitLab REST API uses 'opened' (not 'open'). 'all'
  // omits the param entirely.
  if (params.state !== undefined && params.state !== 'all') {
    const mapped: Record<Exclude<typeof params.state, 'all'>, string> = {
      open: 'opened',
      closed: 'closed',
      merged: 'merged',
    };
    queryParts.push(`state=${mapped[params.state as 'open' | 'closed' | 'merged']}`);
  }

  if (params.head !== undefined) {
    queryParts.push(`source_branch=${encodeURIComponent(params.head)}`);
  }
  if (params.base !== undefined) {
    queryParts.push(`target_branch=${encodeURIComponent(params.base)}`);
  }
  if (params.author !== undefined) {
    queryParts.push(`author_username=${encodeURIComponent(params.author)}`);
  }
  if (params.limit !== undefined) {
    queryParts.push(`per_page=${String(params.limit)}`);
  }

  // No "empty output means no MRs" here. #428 added that mapping for an
  // "intermittent" empty response, and the response was this bug: every query
  // with two or more params was backgrounded by its unquoted `&` (#585).
  const endpoint = `projects/${path}/merge_requests${queryString(queryParts)}`;
  return parseList<GitlabMr>(execGlab(['glab', 'api', endpoint], cwd), endpoint);
}

function queryString(parts: string[]): string {
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

/**
 * List pipelines with optional filters.
 *
 * Endpoint: `GET /projects/:id/pipelines?<query>`
 *
 * `onArgv` receives the argv about to run, so a caller reporting "no pipeline
 * found" can show the query that actually ran (#493's `queried_argv`) without
 * re-resolving the project path.
 */
export function gitlabApiCiList(
  params: {
    ref?: string;
    limit?: number;
    sha?: string;
  },
  opts?: { owner?: string; repo?: string },
  onArgv?: (argv: string[]) => void,
): GitlabPipeline[] {
  const path = projectPath(opts);
  const queryParts: string[] = [];

  if (params.ref !== undefined) {
    queryParts.push(`ref=${encodeURIComponent(params.ref)}`);
  }
  if (params.sha !== undefined) {
    queryParts.push(`sha=${encodeURIComponent(params.sha)}`);
  }
  if (params.limit !== undefined) {
    queryParts.push(`per_page=${String(params.limit)}`);
  }

  // Empty output throws, as in gitlabApiMrList (#585).
  const endpoint = `projects/${path}/pipelines${queryString(queryParts)}`;
  const argv = ['glab', 'api', endpoint];
  onArgv?.(argv);
  return parseList<GitlabPipeline>(execGlab(argv), endpoint);
}

/**
 * Fetch the current project's metadata.
 *
 * Endpoint: `GET /projects/:id`
 */
export function gitlabApiRepo(): GitlabRepo {
  const path = projectPath();
  const raw = execGlab(['glab', 'api', `projects/${path}`]);
  return JSON.parse(raw) as GitlabRepo;
}

