// Wave-init plan/state helpers — platform-agnostic parsing, fixture I/O, and
// KAHUNA bootstrap orchestration. Extracted from `handlers/wave_init.ts` per
// Story 2.22 (#316) so the handler shell stays ≤80 lines and contains no
// platform branching or direct subprocess invocation.

import { writeFileSync } from 'fs';
import { join } from 'path';

import type { PlatformAdapter, AdapterResult } from './adapters/index.js';
import { branchExistsOnRemote } from './shared/git-remote.js';

export interface PlanWave {
  id?: string;
  issues?: unknown[];
}

export interface PlanPhase {
  waves?: PlanWave[];
}

export interface PlanData {
  phases?: PlanPhase[];
  base_branch?: string;
}

export interface StateData {
  waves?: Record<string, unknown>;
  kahuna_branch?: string | null;
}

export interface PhasesWavesData {
  phases?: Array<{ waves?: unknown[] }>;
}

export function projectDir(override?: string): string {
  if (override !== undefined && override.length > 0) return override;
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

export function writePlanFile(planJson: string): string {
  const path = `/tmp/wave-init-plan-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`;
  writeFileSync(path, planJson);
  return path;
}

export async function fileExists(path: string): Promise<boolean> {
  return await Bun.file(path).exists();
}

export async function readJson(path: string): Promise<unknown> {
  return await Bun.file(path).json();
}

export async function statusDir(root: string): Promise<string> {
  // Prefer .sdlc/waves/ if .sdlc/ exists; otherwise fall back to .claude/status/.
  const sdlc = join(root, '.sdlc');
  if (await fileExists(sdlc)) return join(sdlc, 'waves');
  return join(root, '.claude', 'status');
}

/**
 * Detect and transform `/devspec upshift` plan shape into `wave-status init`
 * shape. The upshift format uses `waves[].name` + `waves[].stories[]` while
 * wave-status expects `waves[].id` + `waves[].issues[]`. Also injects
 * top-level `project` from the plan's own slug field or the provided repo slug.
 *
 * Returns the JSON string (transformed if needed, original if already correct).
 */
export function normalizePlanJson(planJson: string, repoSlug?: string): string {
  let plan: Record<string, unknown>;
  try { plan = JSON.parse(planJson); }
  catch { return planJson; }

  const phases = plan.phases as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(phases) || phases.length === 0) return planJson;

  const firstWave = (phases[0].waves as Array<Record<string, unknown>> | undefined)?.[0];
  if (!firstWave) return planJson;

  const isUpshiftShape = Array.isArray(firstWave.stories) || (firstWave.name !== undefined && firstWave.id === undefined);
  if (!isUpshiftShape) return planJson;

  const project = (plan.project as string) ?? repoSlug ?? (plan.slug as string) ?? undefined;
  const transformed: Record<string, unknown> = { ...plan };
  if (project) transformed.project = project;

  transformed.phases = phases.map((phase) => {
    const waves = (phase.waves as Array<Record<string, unknown>> | undefined) ?? [];
    return {
      ...phase,
      waves: waves.map((wave) => {
        const id = (wave.id as string) ?? (wave.name as string) ?? undefined;
        const stories = (wave.stories as Array<Record<string, unknown>> | undefined) ?? [];
        const issues = (wave.issues as unknown[] | undefined) ?? stories.map((story) => {
          const issueNum = (story.issue as number) ?? (story.number as number);
          const storyRepo = (story.repo as string) ?? project;
          const ref = storyRepo ? `${storyRepo}#${issueNum}` : `#${issueNum}`;
          return { number: issueNum, repo: storyRepo, ref, title: story.title, depends_on: story.depends_on };
        });
        const result: Record<string, unknown> = { ...wave, id, issues };
        delete result.name;
        delete result.stories;
        return result;
      }),
    };
  });

  return JSON.stringify(transformed);
}

export function countIssuesFromPlan(plan: PlanData): {
  phases_added: number;
  waves_added: number;
  issues_added: number;
} {
  const phases = plan.phases ?? [];
  let waves_added = 0;
  let issues_added = 0;
  for (const phase of phases) {
    for (const wave of phase.waves ?? []) {
      waves_added += 1;
      issues_added += (wave.issues ?? []).length;
    }
  }
  return {
    phases_added: phases.length,
    waves_added,
    issues_added,
  };
}

export function extractPlanWaveIds(plan: PlanData): string[] {
  const ids: string[] = [];
  for (const phase of plan.phases ?? []) {
    for (const wave of phase.waves ?? []) {
      if (typeof wave.id === 'string' && wave.id.length > 0) {
        ids.push(wave.id);
      }
    }
  }
  return ids;
}

/**
 * Pre-scan the extend-mode plan against on-disk state to detect wave-ID
 * collisions BEFORE shelling out to the `wave-status` CLI. Returns
 * `{ok:false, error}` when state is missing or a collision is found, else
 * `{ok:true}` to signal "proceed". The CLI has its own collision guard;
 * this is defense-in-depth + clearer error envelope.
 */
export async function extendModePrescan(
  planJson: string,
  root: string,
): Promise<
  | { ok: true }
  | { ok: false; error: string; colliding_ids?: string[] }
> {
  let plan: PlanData;
  try {
    plan = JSON.parse(planJson) as PlanData;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `plan_json is not valid JSON: ${detail}` };
  }

  const dir = await statusDir(root);
  const statePath = join(dir, 'state.json');
  if (!(await fileExists(statePath))) {
    return { ok: false, error: 'no existing plan found' };
  }

  const state = (await readJson(statePath)) as StateData;
  const existingIds = new Set(Object.keys(state.waves ?? {}));
  const incomingIds = extractPlanWaveIds(plan);
  const colliding = incomingIds.filter((id) => existingIds.has(id));
  if (colliding.length > 0) {
    return {
      ok: false,
      error: `wave ID collision: ${colliding.join(', ')} already exist`,
      colliding_ids: colliding,
    };
  }
  return { ok: true };
}

/**
 * After the wave-status CLI has written `phases-waves.json`, read it back
 * so the handler can report project totals. Returns `{0,0}` rather than
 * failing the whole call if the file is missing or malformed — the CLI
 * already succeeded at writing state.
 */
export async function readPhasesWavesTotals(
  root: string,
): Promise<{ total_phases: number; total_waves: number }> {
  try {
    const dir = await statusDir(root);
    const phasesPath = join(dir, 'phases-waves.json');
    if (!(await fileExists(phasesPath))) return { total_phases: 0, total_waves: 0 };
    const data = (await readJson(phasesPath)) as PhasesWavesData;
    const phases = data.phases ?? [];
    let total_waves = 0;
    for (const p of phases) total_waves += (p.waves ?? []).length;
    return { total_phases: phases.length, total_waves };
  } catch {
    return { total_phases: 0, total_waves: 0 };
  }
}

// ---------------------------------------------------------------------------
// KAHUNA bootstrap — platform-facing calls go through the `PlatformAdapter`
// so the handler remains free of platform branching (R-09).
//
// Atomicity (#378): the bootstrap is split into two phases so the handler
// can interleave them around the `wave-status init` plan-persist step:
//
//   1. `bootstrapKahunaBranchRemote` — pre-check + create branch on remote.
//      Reads state.json if present (extend mode), tolerates absence (fresh
//      init). Returns `{ok, kahuna_branch, created}` or error. NO state.json
//      writes — safe to run BEFORE `wave-status init` exists.
//   2. Handler runs `wave-status init` to persist the plan to disk.
//   3. `recordKahunaBranchInState` — writes the branch name into state.json
//      via `wave-status set-kahuna-branch`. Must run AFTER step 2 because
//      `set-kahuna-branch` requires state.json to exist.
//
// Failure modes after resequencing:
// - Phase 1 fails → no plan persisted, no remote branch (createBranch is
//   atomic at the platform API level). Retry converges trivially.
// - Phase 2 fails → remote branch exists but state empty. Retry's phase 1
//   sees `recorded === null` AND remote has desired → claims as idempotent
//   reuse (NOT orphan-refused). This is the key behavior change vs the
//   pre-#378 single-phase function: "orphan with matching name" is now a
//   successful claim, not an error, because the branch name is fully
//   determined by `kahuna/<plan_id>-<slug>` and a name collision across
//   different plans is impossible (plan_id is the unique tracking-issue
//   number for the master plan).
// - Phase 3 fails → `wave-status set-kahuna-branch` is a local file write
//   and rarely fails; if it does, the plan is fully persisted and the remote
//   branch exists, but state.json has no kahuna_branch field. Closed by #406:
//   the handler detects this half-state on retry (plan on disk + branch claimed
//   via the reuse path + state unrecorded) and resumes at phase 3 to record the
//   branch, skipping the plan re-persist a non-extend retry would otherwise run.
//   wave_init is now atomic across all four steps.
// ---------------------------------------------------------------------------

export interface KahunaBootstrapResult {
  ok: true;
  kahuna_branch: string;
  /** `true` if the adapter created the remote branch in this call; `false` if a
   * matching branch already existed (claim/reuse). */
  created: boolean;
  /** `true` if state.json's `kahuna_branch` already matched `desired` before
   * this call (idempotent-reuse path). Handler uses this to skip the redundant
   * `wave-status set-kahuna-branch` write. `false` when state was empty or the
   * call created a new branch — in both cases the handler must record. */
  previously_recorded: boolean;
}
export interface KahunaBootstrapError {
  ok: false;
  error: string;
}

export interface KahunaBootstrapRemoteDeps {
  adapter: Pick<PlatformAdapter, 'resolveBranchSha' | 'createBranch'>;
  /** `git ls-remote` probe — local git, not a platform API. Injectable for testing. */
  branchPresentOnRemote: (branch: string) => boolean;
  slug: string | undefined;
}

/** Back-compat alias — pre-#378 callers passed a `recordKahunaBranch` callback. */
export interface KahunaBootstrapDeps extends KahunaBootstrapRemoteDeps {
  /** CLI shell-out — `wave-status set-kahuna-branch <name>`. Injectable for testing. */
  recordKahunaBranch: (branch: string) => void;
}

/**
 * Resolve the integration branch name to create (#503).
 *
 * The name used to be derived here unconditionally as `kahuna/<plan_id>-<slug>`,
 * which encodes two assumptions that hold for a standalone wave and fail for a
 * campaign: the branch is per-PLAN (so it is shared by every wave of that plan,
 * and the per-wave promote that deletes it destroys the next wave's base), and
 * it is cut from the plan's base (so a later wave forks a baseline missing the
 * earlier waves' integrated work). A campaign needs one branch PER WAVE, cut
 * from the campaign branch — a name only the caller can know.
 *
 * So: an explicit `branch` wins verbatim; absent one, the historical derived name
 * is kept, because it is still correct for the standalone single-wave case and
 * existing callers depend on it.
 *
 * Two limits worth knowing before you rely on this:
 *
 * 1. The guard below forbids the integration branch from BEING the base or the repo
 *    default; it cannot check what the branch is cut FROM. A caller that names a
 *    per-wave branch but omits `plan.base_branch` gets a wave branch forked from
 *    trunk — legal here, wrong for a campaign. Naming the branch and setting the
 *    base are one decision; make them together.
 * 2. As of #503 the live wave engine still cuts the per-wave branch client-side
 *    (claudecode-workflow `skills/nextwave/per-wave-workflow.js`) and carries its own
 *    copy of these inequality assertions, so this path is exercised by tests rather
 *    than by the campaign hot path. Two implementations of one invariant drift —
 *    when the engine moves to the server-side bootstrap, delete its copy.
 */
export function kahunaBranchName(
  kahuna: { plan_id: number; slug: string; branch?: string },
): { ok: true; branch: string } | KahunaBootstrapError {
  if (kahuna.branch === undefined) {
    return { ok: true, branch: `kahuna/${kahuna.plan_id}-${kahuna.slug}` };
  }
  const branch = kahuna.branch;
  // Validate before handing it to `git`/the platform API. An invalid ref fails at
  // create time with a platform-specific message that reads like an auth or
  // network fault; naming the actual problem here is the difference between a
  // one-line fix and a triage session. Rules per git-check-ref-format(1), plus a
  // leading-`-` guard (argv injection) and a `refs/` guard (double-qualification).
  const invalid =
    branch.trim() !== branch ? 'has leading or trailing whitespace'
    : /\s/.test(branch) ? 'contains whitespace'
    : branch.startsWith('/') || branch.endsWith('/') ? 'starts or ends with "/"'
    : branch.includes('//') ? 'contains an empty path component ("//")'
    : branch.startsWith('-') ? 'starts with "-" (would be read as a command-line flag)'
    : branch.startsWith('refs/') ? 'is fully qualified — pass a branch name, not a refs/ path'
    : branch.endsWith('.') || branch.endsWith('.lock') ? 'ends with "." or ".lock"'
    : branch.includes('..') ? 'contains ".."'
    : branch.includes('@{') ? 'contains "@{"'
    : /[~^:?*[\\]/.test(branch) ? 'contains one of ~ ^ : ? * [ \\'
    // eslint-disable-next-line no-control-regex
    : /[\x00-\x1f\x7f]/.test(branch) ? 'contains a control character'
    : null;
  if (invalid !== null) {
    return { ok: false, error: `kahuna branch '${branch}' is not a valid git ref: it ${invalid}` };
  }
  return { ok: true, branch };
}

/**
 * Phase 1 of #378's atomic kahuna bootstrap: pre-check state + create the
 * branch on remote, but do NOT write to state.json. Safe to call BEFORE
 * `wave-status init` (state.json may not yet exist).
 *
 * `readState` should return `{kahuna_branch: null}` when state.json is
 * absent (fresh init). Callers in the handler use a wrapper that swallows
 * ENOENT and yields the empty default.
 */
export async function bootstrapKahunaBranchRemote(
  cwd: string,
  kahuna: { plan_id: number; slug: string; branch?: string },
  baseBranch: string,
  readState: () => Promise<{ kahuna_branch?: string | null }>,
  deps: KahunaBootstrapRemoteDeps,
  /** The repo's live default branch, when the caller knows it. A DISTINCT ref from
   *  `baseBranch` whenever the plan sets an explicit base (a campaign branch), and
   *  the one ref an integration branch must never be — see the guard below (#503). */
  defaultBranch?: string,
): Promise<KahunaBootstrapResult | KahunaBootstrapError> {
  void cwd;
  const named = kahunaBranchName(kahuna);
  if (!named.ok) return named;
  const desired = named.branch;
  // A branch that IS the base is not an integration branch — flights would merge
  // straight into the ref the gate diffs them against, and the gate's own diff would
  // be empty by the time it looked. And a branch that is the PROTECTED default is
  // worse: it exists already, so the reuse path below would claim trunk itself as
  // the integration branch and every flight would merge straight to it — the exact
  // early-trunk-write claudecode-workflow#1052 removed. Reject both (#503).
  for (const [role, ref] of [['base branch', baseBranch], ['repo default branch', defaultBranch]] as const) {
    if (ref !== undefined && desired === ref) {
      return {
        ok: false,
        error:
          `kahuna branch '${desired}' is the same ref as the ${role} — a wave integrates onto its ` +
          `own branch and is diffed AGAINST the base; the two cannot be equal`,
      };
    }
  }
  const state = await readState();
  const recorded = state.kahuna_branch ?? null;

  if (recorded === desired) {
    if (deps.branchPresentOnRemote(desired)) {
      return { ok: true, kahuna_branch: desired, created: false, previously_recorded: true };
    }
    return {
      ok: false,
      error: `kahuna_branch ${desired} is recorded in state but missing from remote — manual triage required`,
    };
  }
  if (recorded !== null && recorded !== desired) {
    return {
      ok: false,
      error: `wave state already records kahuna_branch '${recorded}' which does not match requested '${desired}'`,
    };
  }

  // recorded === null: state unset. Check the remote for an existing branch
  // matching `desired`.
  //
  // #378: if the remote has the EXACT desired branch, claim it as idempotent reuse
  // rather than refusing as an orphan. The branch name is fully determined by
  // request inputs; for the derived name a true "orphan from a different plan" is
  // impossible because plan_id is the unique tracking-issue number for the master
  // plan, and (plan_id, slug) is a deterministic mapping. This makes wave_init
  // retry-safe after a phase-2 (`wave-status init`) failure that left the branch on
  // remote but no state.json.
  //
  // #503: with a caller-supplied `branch` that uniqueness argument is the CALLER's
  // to make — this reuses whatever it finds under that name. That is the right
  // behavior (an existing integration branch carries work already merged into it,
  // so re-cutting would discard it), but it means a caller who reuses one name
  // across two campaigns gets their commits interleaved on one branch. Callers must
  // namespace the name; the engine does so as `kahuna/<planId>-<waveId>`.
  if (deps.branchPresentOnRemote(desired)) {
    return { ok: true, kahuna_branch: desired, created: false, previously_recorded: false };
  }

  // Fresh creation path — adapter reads main HEAD SHA + creates the branch.
  const shaResult = await deps.adapter.resolveBranchSha({ branch: baseBranch, repo: deps.slug });
  const sha = extractSha(shaResult);
  if (sha === null) {
    return { ok: false, error: shaErrorMessage(baseBranch, shaResult) };
  }
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    return { ok: false, error: `unexpected SHA from resolveBranchSha: ${sha.slice(0, 80)}` };
  }
  const createResult = await deps.adapter.createBranch({ branch: desired, sha, repo: deps.slug });
  if ('platform_unsupported' in createResult) {
    return { ok: false, error: `createBranch platform_unsupported: ${createResult.hint}` };
  }
  if (!createResult.ok) {
    return { ok: false, error: createResult.error };
  }

  return { ok: true, kahuna_branch: desired, created: true, previously_recorded: false };
}

/**
 * Phase 3 of #378's atomic kahuna bootstrap: record the branch name in
 * state.json via `wave-status set-kahuna-branch`. Must run AFTER
 * `wave-status init` (which creates state.json). Idempotent — safe to call
 * even when the branch was discovered as already-existing in phase 1.
 */
export function recordKahunaBranchInState(
  branch: string,
  recordKahunaBranch: (branch: string) => void,
): { ok: true } | KahunaBootstrapError {
  try {
    recordKahunaBranch(branch);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: `wave-status set-kahuna-branch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Pre-#378 single-phase entry point — kept for back-compat with any caller
 * outside the wave_init handler. New callers should use the resequenced
 * pair (`bootstrapKahunaBranchRemote` + `recordKahunaBranchInState`) so
 * plan-persist failures don't strand a branch on remote with no state.
 *
 * @deprecated Use the two-phase API for atomic bootstrap. See #378.
 */
export async function bootstrapKahunaBranch(
  cwd: string,
  kahuna: { plan_id: number; slug: string; branch?: string },
  baseBranch: string,
  readState: () => Promise<{ kahuna_branch?: string | null }>,
  deps: KahunaBootstrapDeps,
  defaultBranch?: string,
): Promise<KahunaBootstrapResult | KahunaBootstrapError> {
  const remote = await bootstrapKahunaBranchRemote(cwd, kahuna, baseBranch, readState, deps, defaultBranch);
  if (!remote.ok) return remote;
  if (!remote.previously_recorded) {
    const recorded = recordKahunaBranchInState(remote.kahuna_branch, deps.recordKahunaBranch);
    if (!recorded.ok) return recorded;
  }
  return remote;
}

function extractSha(
  result: AdapterResult<{ sha: string } | null>,
): string | null {
  if ('platform_unsupported' in result) return null;
  if (!result.ok) return null;
  if (result.data === null) return null;
  return result.data.sha;
}

function shaErrorMessage(
  baseBranch: string,
  result: AdapterResult<{ sha: string } | null>,
): string {
  if ('platform_unsupported' in result) {
    return `failed to read ${baseBranch} HEAD SHA: ${result.hint}`;
  }
  if (!result.ok) {
    return `failed to read ${baseBranch} HEAD SHA: ${result.error}`;
  }
  return `failed to read ${baseBranch} HEAD SHA: branch not found`;
}

// Re-export the shared git-remote helper for the handler's injection.
export { branchExistsOnRemote };
