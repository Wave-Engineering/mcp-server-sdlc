/**
 * Shared GitLab REST API (`glab api`) wrappers used by GitLab platform
 * adapters in `lib/adapters/*-gitlab.ts`.
 *
 * Strictly GitLab-specific: REST response types and typed wrappers around
 * `glab api projects/...` endpoints. `detectPlatform`, `detectPlatformForRef`,
 * and `parseRepoSlug` live in `lib/shared/` (Story 1.2, R-17).
 *
 * Why `glab api` and not `glab <sub> view --output json`:
 * `glab 1.36.0` has no `--output` flag on any view or list subcommand
 * (`issue view`, `mr view`, `mr list`, `ci list`, `repo view` all reject it).
 * `glab api` invokes the GitLab REST API v4 directly and returns native JSON.
 */

import { execSync } from 'child_process';
import { parseRepoSlug } from './shared/parse-repo-slug.js';

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

function execGlab(cmd: string, cwd?: string): string {
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
  return raw;
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
  const raw = execGlab(`glab api projects/${path}/issues/${String(iid)}`);
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
  const raw = execGlab(`glab api projects/${path}/merge_requests/${String(iid)}`);
  return JSON.parse(raw) as GitlabMr;
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

  const query = queryParts.length > 0 ? `?${queryParts.join('&')}` : '';
  let raw: string;
  try {
    raw = execGlab(`glab api projects/${path}/merge_requests${query}`, cwd);
  } catch (err) {
    // List endpoints: empty output means "no results" — return [] rather
    // than propagating "empty output" as a fatal error (#428).
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('empty output')) return [];
    throw err;
  }
  return JSON.parse(raw) as GitlabMr[];
}

/**
 * List pipelines with optional filters.
 *
 * Endpoint: `GET /projects/:id/pipelines?<query>`
 */
export function gitlabApiCiList(
  params: {
    ref?: string;
    limit?: number;
    sha?: string;
  },
  opts?: { owner?: string; repo?: string },
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

  const query = queryParts.length > 0 ? `?${queryParts.join('&')}` : '';
  let raw: string;
  try {
    raw = execGlab(`glab api projects/${path}/pipelines${query}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('empty output')) return [];
    throw err;
  }
  return JSON.parse(raw) as GitlabPipeline[];
}

/**
 * Fetch the current project's metadata.
 *
 * Endpoint: `GET /projects/:id`
 */
export function gitlabApiRepo(): GitlabRepo {
  const path = projectPath();
  const raw = execGlab(`glab api projects/${path}`);
  return JSON.parse(raw) as GitlabRepo;
}

/**
 * Report whether a branch is protected on the host (#465).
 *
 * Endpoint: `GET /projects/:id/protected_branches/:name`
 *  - HTTP 200 ⇒ the branch is protected (returns the protection record).
 *  - HTTP 404 ⇒ the branch is not protected.
 *
 * `glab api` maps a 404 to a non-zero exit, which `execGlab` rethrows as a
 * `glab failed (…)` error whose message carries the stderr. We interpret a
 * 404 / "not found" message as "not protected" and return `false`; any other
 * failure (auth, network) propagates so callers can surface a real error
 * instead of silently reporting the branch as unprotected.
 */
export function gitlabApiProtectedBranch(
  branch: string,
  opts?: { owner?: string; repo?: string },
  cwd?: string,
): boolean {
  const path = projectPath(opts, cwd);
  try {
    const raw = execGlab(
      `glab api projects/${path}/protected_branches/${encodeURIComponent(branch)}`,
      cwd,
    );
    // 200 returns the protection record; parse to fail loudly on garbage.
    JSON.parse(raw);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    if (/404|not found/i.test(msg)) return false;
    throw err;
  }
}
