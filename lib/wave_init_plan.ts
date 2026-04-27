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
// ---------------------------------------------------------------------------

export interface KahunaBootstrapResult {
  ok: true;
  kahuna_branch: string;
  created: boolean;
}
export interface KahunaBootstrapError {
  ok: false;
  error: string;
}

export interface KahunaBootstrapDeps {
  adapter: Pick<PlatformAdapter, 'resolveBranchSha' | 'createBranch'>;
  /** CLI shell-out — `wave-status set-kahuna-branch <name>`. Injectable for testing. */
  recordKahunaBranch: (branch: string) => void;
  /** `git ls-remote` probe — local git, not a platform API. Injectable for testing. */
  branchPresentOnRemote: (branch: string) => boolean;
  slug: string | undefined;
}

export async function bootstrapKahunaBranch(
  cwd: string,
  kahuna: { epic_id: number; slug: string },
  baseBranch: string,
  readState: () => Promise<{ kahuna_branch?: string | null }>,
  deps: KahunaBootstrapDeps,
): Promise<KahunaBootstrapResult | KahunaBootstrapError> {
  void cwd;
  const desired = `kahuna/${kahuna.epic_id}-${kahuna.slug}`;
  const state = await readState();
  const recorded = state.kahuna_branch ?? null;

  if (recorded === desired) {
    if (deps.branchPresentOnRemote(desired)) {
      return { ok: true, kahuna_branch: desired, created: false };
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

  // recorded === null: state unset. Check the remote for an orphan.
  if (deps.branchPresentOnRemote(desired)) {
    return {
      ok: false,
      error: `orphan kahuna branch ${desired} exists on remote but is not recorded in state — manual triage required`,
    };
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

  try {
    deps.recordKahunaBranch(desired);
  } catch (err) {
    return {
      ok: false,
      error: `wave-status set-kahuna-branch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { ok: true, kahuna_branch: desired, created: true };
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
