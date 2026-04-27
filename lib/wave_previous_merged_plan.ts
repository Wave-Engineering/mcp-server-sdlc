/**
 * Platform-agnostic plan/state helpers lifted from `wave_previous_merged`
 * during Story 2.20 (#314). The handler shrinks to ≤80 lines by extracting
 * these pure JSON-parsing helpers here; none touch platform adapters or
 * subprocess calls.
 *
 * Schema ownership: `state.json` and `phases-waves.json` are owned by the
 * cc-workflow Python `wave_status` CLI; this module only READS them. The TS
 * handler may mutate the `current_wave` pointer via a separate handler
 * (`wave_complete`) — NOT this one.
 */

import { join } from 'path';

export function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

export async function fileExists(path: string): Promise<boolean> {
  return await Bun.file(path).exists();
}

export async function readJson(path: string): Promise<unknown> {
  return await Bun.file(path).json();
}

export async function statusDir(root: string): Promise<string> {
  const sdlc = join(root, '.sdlc');
  if (await fileExists(sdlc)) return join(sdlc, 'waves');
  return join(root, '.claude', 'status');
}

export interface PlanIssue {
  number: number;
}
export interface PlanWave {
  id: string;
  issues?: PlanIssue[];
}
export interface PlanPhase {
  waves?: PlanWave[];
}
export interface PlanData {
  phases?: PlanPhase[];
}

export interface WaveState {
  status?: string;
}

// One deferral entry from `state.deferrals[]`. Schema is owned by the Python
// `wave_status` CLI in claudecode-workflow (see `src/wave_status/deferrals.py`):
//   { wave: <wave_id>, description: <free-form>, risk: low|medium|high, status: pending|accepted }
// The deferred issue number is conventionally embedded in `description` as a
// `#N` reference (e.g. "Defer #420 (story title) — reason"). There is no
// structured `issue_number` field on disk today.
export interface Deferral {
  wave?: string;
  description?: string;
  risk?: string;
  status?: string;
}

export interface StateData {
  current_wave?: string | null;
  waves?: Record<string, WaveState>;
  deferrals?: Deferral[];
}

// Extract the set of issue numbers covered by accepted deferrals against the
// given wave. The `#N` pattern matches the established convention in
// cc-workflow's deferrals (canonical fixture: `"Defer #420 (test...): ..."`).
// The negative lookbehind `(?<!\w)` ensures we only match `#N` at a word
// boundary — `abc#123` or markdown anchors `[link](#123-section)` will not
// extract `123`. Multiple `#N` references in one description are all
// collected; the caller also intersects against the wave's planned issues
// as a second safety net.
//
// Why filter only ACCEPTED (not pending): an accepted deferral is the
// completion contract for the wave — the team explicitly agreed the issue
// wouldn't merge in this wave. Pending deferrals are still under discussion
// and SHOULD continue to count as open. See #223 + lesson_wave_status_commands.md.
export function deferredIssueNumbers(state: StateData, waveId: string): Set<number> {
  const out = new Set<number>();
  for (const d of state.deferrals ?? []) {
    if (d.status !== 'accepted' || d.wave !== waveId) continue;
    for (const m of (d.description ?? '').matchAll(/(?<!\w)#(\d+)/g)) {
      out.add(parseInt(m[1], 10));
    }
  }
  return out;
}

export function flatWaveIds(plan: PlanData): string[] {
  const ids: string[] = [];
  for (const phase of plan.phases ?? []) {
    for (const wave of phase.waves ?? []) {
      ids.push(wave.id);
    }
  }
  return ids;
}

export function findWave(plan: PlanData, id: string): PlanWave | null {
  for (const phase of plan.phases ?? []) {
    for (const wave of phase.waves ?? []) {
      if (wave.id === id) return wave;
    }
  }
  return null;
}

export function findPreviousWaveId(plan: PlanData, state: StateData): string | null {
  const ids = flatWaveIds(plan);
  const current = state.current_wave;

  // If current_wave is set, previous is the one before it.
  if (current) {
    const idx = ids.indexOf(current);
    return idx > 0 ? ids[idx - 1] : null;
  }

  // If no current_wave, use the latest wave with status=completed.
  const waves = state.waves ?? {};
  for (let i = ids.length - 1; i >= 0; i--) {
    if (waves[ids[i]]?.status === 'completed') return ids[i];
  }
  return null;
}
