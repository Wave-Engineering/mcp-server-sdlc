// Wave MR-reconcile handler — adapter-dispatching shell. Platform-specific
// subprocess work lives in
// lib/adapters/find-merged-pr-for-branch-prefix-{github,gitlab}.ts. Plan/state
// JSON parsing, wave lookup, and `wave-status record-mr` invocation live in
// lib/wave_reconcile_mrs_plan.ts. See Story 2.21 (#315) — also closes #282
// (hardcoded 50-item scan cap) by plumbing `limit` through to the adapter
// with a default of 100.

import { execSync } from 'child_process';
import { join } from 'path';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { getAdapter } from '../lib/adapters/index.js';
import {
  projectDir, fileExists, readJson, statusDir, findWave, quoteArg,
  type PlanData, type StateData,
} from '../lib/wave_reconcile_mrs_plan.js';

const inputSchema = z.object({
  wave_id: z.string().optional(),
  limit: z.number().int().positive().optional(),
});

interface Reconciled { issue_number: number; mr_ref: string; }
interface ReconcileResult {
  ok: boolean; wave_id: string; reconciled: Reconciled[];
  already_recorded: number; not_found: number[]; error?: string;
}

/** Injection seam for tests — allows intercepting `wave-status record-mr`. */
export interface Deps { execFn: (cmd: string) => string; }
const defaultDeps: Deps = { execFn: (c) => execSync(c, { encoding: 'utf8' }).trim() };
const fail = (wave_id: string, error: string): ReconcileResult =>
  ({ ok: false, wave_id, reconciled: [], already_recorded: 0, not_found: [], error });

export async function reconcile(rawArgs: unknown, deps: Deps = defaultDeps): Promise<ReconcileResult> {
  const args = inputSchema.parse(rawArgs);
  const dir = await statusDir(projectDir());
  const planPath = join(dir, 'phases-waves.json');
  const statePath = join(dir, 'state.json');
  if (!(await fileExists(planPath)) || !(await fileExists(statePath))) return fail('', `state files not found in ${dir}`);

  const plan = (await readJson(planPath)) as PlanData;
  const state = (await readJson(statePath)) as StateData;
  const waveId = args.wave_id ?? state.current_wave ?? '';
  if (!waveId) return fail('', 'no wave_id provided and no current wave set');
  const wave = findWave(plan, waveId);
  if (!wave) return fail(waveId, `wave '${waveId}' not found in plan`);

  const existing = state.waves?.[waveId]?.mr_urls ?? {};
  const adapter = getAdapter();
  const limit = args.limit ?? 100;
  const reconciled: Reconciled[] = [];
  const notFound: number[] = [];
  let alreadyRecorded = 0;

  for (const issue of wave.issues ?? []) {
    if (existing[String(issue.number)]) { alreadyRecorded++; continue; }
    const res = await adapter.findMergedPrForBranchPrefix({ prefix: `feature/${issue.number}-`, limit });
    const mrUrl = 'ok' in res && res.ok && res.data ? res.data.url : null;
    if (!mrUrl) { notFound.push(issue.number); continue; }
    try { deps.execFn(`wave-status record-mr ${issue.number} ${quoteArg(mrUrl)}`); }
    catch { /* best-effort — continue even if record-mr fails */ }
    reconciled.push({ issue_number: issue.number, mr_ref: mrUrl });
  }

  return { ok: true, wave_id: waveId, reconciled, already_recorded: alreadyRecorded, not_found: notFound };
}

const waveReconcileMrsHandler: HandlerDef = {
  name: 'wave_reconcile_mrs',
  description: 'Backfill mr_urls for issues in a wave by querying the platform for merged PRs/MRs matching feature/<N>-* branches. Call site: after wave_preflight, before pr_merge or wave_close_issue.',
  inputSchema,
  async execute(rawArgs: unknown) {
    try { return { content: [{ type: 'text' as const, text: JSON.stringify(await reconcile(rawArgs)) }] }; }
    catch (err) { return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }) }] }; }
  },
};

export default waveReconcileMrsHandler;
