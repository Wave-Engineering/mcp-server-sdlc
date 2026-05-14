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
//   and rarely fails; if it does, the state has no kahuna_branch field but
//   the remote branch exists. Retry would hit `wave-status init`'s "already
//   initialized" guard. Out of scope for #378; tracked separately if it
//   ever arises in practice.
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
  kahuna: { plan_id: number; slug: string },
  baseBranch: string,
  readState: () => Promise<{ kahuna_branch?: string | null }>,
  deps: KahunaBootstrapRemoteDeps,
): Promise<KahunaBootstrapResult | KahunaBootstrapError> {
  void cwd;
  const desired = `kahuna/${kahuna.plan_id}-${kahuna.slug}`;
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
  // #378: if the remote has the EXACT desired branch (`kahuna/<plan_id>-<slug>`),
  // claim it as idempotent reuse rather than refusing as an orphan. The branch
  // name is fully determined by request inputs; a true "orphan from a different
  // plan" is impossible because plan_id is the unique tracking-issue number for
  // the master plan, and (plan_id, slug) is a deterministic mapping. This makes
  // wave_init retry-safe after a phase-2 (`wave-status init`) failure that left
  // the branch on remote but no state.json.
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
  kahuna: { plan_id: number; slug: string },
  baseBranch: string,
  readState: () => Promise<{ kahuna_branch?: string | null }>,
  deps: KahunaBootstrapDeps,
): Promise<KahunaBootstrapResult | KahunaBootstrapError> {
  const remote = await bootstrapKahunaBranchRemote(cwd, kahuna, baseBranch, readState, deps);
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
