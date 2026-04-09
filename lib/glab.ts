/**
 * Shared GitLab CLI adapter.
 *
 * Consolidates platform detection, repo slug parsing, and typed wrappers
 * around the `glab api` CLI for every GitLab-backed handler.
 *
 * Lives in `lib/` so the handler registry codegen ignores it (same as
 * `lib/dependency_graph.ts` and `lib/spec_parser.ts`).
 *
 * Reference implementation that this adapter generalizes:
 * - `handlers/ci_run_logs.ts:81-108` (fetchGitlab pattern)
 * - `handlers/ci_failed_jobs.ts:96` (glab api projects/.../pipelines/<id>/jobs)
 *
 * Why `glab api` and not `glab <sub> view --output json`:
 * `glab 1.36.0` has no `--output` flag on any view or list subcommand
 * (`issue view`, `mr view`, `mr list`, `ci list`, `repo view` all reject it).
 * `glab api` invokes the GitLab REST API v4 directly and returns native JSON.
 */

import { execSync } from 'child_process';

// ---------------------------------------------------------------------------
// Helpers — platform detection and repo slug parsing
// ---------------------------------------------------------------------------

/**
 * Detect whether the current repo's origin is a GitLab or GitHub remote.
 *
 * Returns `'gitlab'` if the origin URL contains `'gitlab'` (matches gitlab.com
 * and any self-hosted `gitlab.<company>.com`), otherwise `'github'`. Falls
 * back to `'github'` if the origin cannot be read.
 *
 * This function is the canonical source of platform detection. Handlers must
 * import this rather than rolling their own (a local copy in `pr_list.ts`
 * previously inverted the check — `url.includes('github')` — which gives the
 * wrong answer for self-hosted enterprise deployments).
 */
export function detectPlatform(): 'github' | 'gitlab' {
  try {
    const url = execSync('git remote get-url origin', { encoding: 'utf8' }).trim();
    return url.includes('gitlab') ? 'gitlab' : 'github';
  } catch {
    return 'github';
  }
}

/**
 * Parse the project slug from the current repo's origin URL.
 *
 * Handles both SSH (`git@host:path.git`) and HTTPS
 * (`https://host/path(.git)?`) remote formats, including deeply nested
 * GitLab group paths (e.g. `org/sub/group/repo`). Returns `null` if the
 * origin cannot be read or the URL does not match the expected pattern.
 *
 * This function is the canonical source of slug parsing.
 */
export function parseRepoSlug(): string | null {
  try {
    const url = execSync('git remote get-url origin', { encoding: 'utf8' }).trim();
    // SSH: git@host:path/to/repo.git → capture everything after ':'
    // HTTPS: https://host/path/to/repo.git → capture everything after host '/'
    const m = /(?:git@[^:]+:|https?:\/\/[^/]+\/)(.+?)(?:\.git)?$/.exec(url);
    if (m) return m[1];
    return null;
  } catch {
    return null;
  }
}

/**
 * URL-encoded project path suitable for `glab api projects/<path>/...`
 * endpoints. GitLab REST API v4 accepts either the numeric project ID or the
 * URL-encoded `owner/repo` slug (e.g. `owner%2Frepo`).
 *
 * Throws if the origin URL cannot be parsed. Callers that want a graceful
 * fallback should catch the error and fall through to the GitHub code path.
 */
export function gitlabProjectPath(): string {
  const slug = parseRepoSlug();
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

function execGlab(cmd: string): string {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 64 });
}

/**
 * Build a URL-encoded project path, using explicit owner/repo if provided,
 * otherwise falling back to the current repo's slug.
 */
function projectPath(opts?: { owner?: string; repo?: string }): string {
  if (opts && opts.owner && opts.repo) {
    return encodeURIComponent(`${opts.owner}/${opts.repo}`);
  }
  return gitlabProjectPath();
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
export function gitlabApiMrList(params: {
  head?: string;
  base?: string;
  state?: 'open' | 'closed' | 'merged' | 'all';
  author?: string;
  limit?: number;
}): GitlabMr[] {
  const path = projectPath();
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
  const raw = execGlab(`glab api projects/${path}/merge_requests${query}`);
  return JSON.parse(raw) as GitlabMr[];
}

/**
 * List pipelines with optional filters.
 *
 * Endpoint: `GET /projects/:id/pipelines?<query>`
 */
export function gitlabApiCiList(params: {
  ref?: string;
  limit?: number;
}): GitlabPipeline[] {
  const path = projectPath();
  const queryParts: string[] = [];

  if (params.ref !== undefined) {
    queryParts.push(`ref=${encodeURIComponent(params.ref)}`);
  }
  if (params.limit !== undefined) {
    queryParts.push(`per_page=${String(params.limit)}`);
  }

  const query = queryParts.length > 0 ? `?${queryParts.join('&')}` : '';
  const raw = execGlab(`glab api projects/${path}/pipelines${query}`);
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
