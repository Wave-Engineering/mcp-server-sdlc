// Plan/state JSON parsing + wave lookup helpers for wave_reconcile_mrs
// (Story 2.21, #315). Platform-agnostic — no subprocess, no adapter calls.
// Exists so the handler stays ≤80 lines and the pieces are independently
// unit-testable.

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
  mr_urls?: Record<string, string>;
}

export interface StateData {
  current_wave?: string | null;
  waves?: Record<string, WaveState>;
}

export function findWave(plan: PlanData, id: string): PlanWave | null {
  for (const phase of plan.phases ?? []) {
    for (const wave of phase.waves ?? []) {
      if (wave.id === id) return wave;
    }
  }
  return null;
}

export function quoteArg(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
