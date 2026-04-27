// Wave-completion closure-check handler — adapter-dispatching shell.
// Platform-specific subprocess work lives in
// lib/adapters/fetch-issue-closure-{github,gitlab}.ts. Plan/state JSON parsing,
// deferral filtering, and previous-wave selection live in
// lib/wave_previous_merged_plan.ts. See Story 2.20 (#314).

import { join } from 'path';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { parseRepoSlug } from '../lib/shared/parse-repo-slug.js';
import { getAdapter } from '../lib/adapters/index.js';
import {
  projectDir, fileExists, readJson, statusDir,
  findPreviousWaveId, findWave, deferredIssueNumbers,
  type PlanData, type StateData,
} from '../lib/wave_previous_merged_plan.js';

const inputSchema = z.object({}).strict();

function envelope(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

const wavePreviousMergedHandler: HandlerDef = {
  name: 'wave_previous_merged',
  description: "Verify the previous wave's issues are all closed via merged PRs",
  inputSchema,
  async execute(rawArgs: unknown) {
    try { inputSchema.parse(rawArgs); }
    catch (err) { return envelope({ ok: false, error: err instanceof Error ? err.message : String(err) }); }

    try {
      const dir = await statusDir(projectDir());
      const planPath = join(dir, 'phases-waves.json');
      const statePath = join(dir, 'state.json');
      if (!(await fileExists(planPath)) || !(await fileExists(statePath))) {
        return envelope({ ok: false, error: `state files not found in ${dir}` });
      }

      const plan = (await readJson(planPath)) as PlanData;
      const state = (await readJson(statePath)) as StateData;
      const prevId = findPreviousWaveId(plan, state);
      if (!prevId) {
        return envelope({ ok: true, previous_wave_id: null, all_merged: true, open_issues: [], deferred_issues: [] });
      }
      const prevWave = findWave(plan, prevId);
      if (!prevWave) return envelope({ ok: false, error: `previous wave '${prevId}' not found in plan` });

      const slug = parseRepoSlug() ?? undefined;
      const adapter = getAdapter({ repo: slug });
      const openIssues: number[] = [];
      const deferredIssues = deferredIssueNumbers(state, prevId);
      const deferredFiltered: number[] = [];

      for (const issue of prevWave.issues ?? []) {
        // Accepted-deferred issues are part of the wave's completion contract
        // — skip them entirely (no closure check). See #223.
        if (deferredIssues.has(issue.number)) { deferredFiltered.push(issue.number); continue; }
        const res = await adapter.fetchIssueClosure({ number: issue.number, repo: slug });
        if ('platform_unsupported' in res) { openIssues.push(issue.number); continue; }
        if (!res.ok || res.data.state !== 'CLOSED' || !res.data.closedByMergedPR) {
          openIssues.push(issue.number);
        }
      }

      return envelope({
        ok: true, previous_wave_id: prevId, all_merged: openIssues.length === 0,
        open_issues: openIssues, deferred_issues: deferredFiltered,
      });
    } catch (err) {
      return envelope({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  },
};

export default wavePreviousMergedHandler;
