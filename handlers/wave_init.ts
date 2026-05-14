// Wave-init handler — platform-agnostic shell. Platform calls go through
// `getAdapter()`; plan/state helpers live in `lib/wave_init_plan.ts`.
// Story 2.22 (#316).
//
// Atomicity guarantee (#378). The handler interleaves the kahuna bootstrap
// around the `wave-status init` plan-persist call so a kahuna failure can
// never leave a half-state where the plan is on disk but the kahuna branch
// is missing from remote. Sequence:
//
//   1. Validate input (zod) and run extend-mode pre-scan against existing
//      state.json (read-only — no mutation).
//   2. Pre-check kahuna state and CREATE the kahuna branch on remote (if
//      `kahuna` arg provided). On failure → return error; nothing was
//      persisted to disk.
//   3. Run `wave-status init` to persist the plan to disk (creates
//      state.json + phases-waves.json).
//   4. Record the kahuna branch in state.json via `wave-status
//      set-kahuna-branch` (must run after step 3 — set-kahuna-branch
//      requires state.json to exist).
//
// Failure semantics:
// - Step 2 fails → no plan persisted. Retry converges trivially.
// - Step 3 fails → branch exists on remote, no state.json. Retry's step 2
//   sees the existing branch and claims it as idempotent reuse (see the
//   "recorded === null + branch present" path in `bootstrapKahunaBranchRemote`),
//   then proceeds to retry step 3.
import { execSync } from 'child_process';
import { join } from 'path';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { parseRepoSlug } from '../lib/shared/parse-repo-slug.js';
import { getAdapter } from '../lib/adapters/index.js';
import {
  projectDir, writePlanFile, statusDir, readJson, countIssuesFromPlan,
  extendModePrescan, readPhasesWavesTotals, bootstrapKahunaBranchRemote,
  recordKahunaBranchInState, branchExistsOnRemote, fileExists, normalizePlanJson,
  type PlanData, type StateData,
} from '../lib/wave_init_plan.js';
import { repoOptionalSchema } from '../lib/schemas/repo.js';

const inputSchema = z.object({
  plan_json: z.string().min(1, 'plan_json must be a non-empty JSON string'),
  extend: z.boolean().optional().default(false),
  force: z.boolean().optional().default(false),
  project_root: z.string().optional(),
  // GitLab nested groups need arbitrary `/` depth — see lib/schemas/repo.ts (#290).
  repo: repoOptionalSchema,
  kahuna: z.object({
    plan_id: z.number().int().positive(),
    slug: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/, 'slug must be kebab-case (lowercase, digits, hyphens)'),
  }).strict().optional(),
});

const envelope = (payload: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(payload) }] });
const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Read state.json, tolerating its absence (fresh-init mode where the file
 * doesn't exist yet because `wave-status init` hasn't run). Returns the
 * empty default `{kahuna_branch: null}` when missing — callers feed this
 * into `bootstrapKahunaBranchRemote` which treats null-recorded as "fresh
 * or recoverable claim" depending on remote state.
 */
async function readStateOrDefault(statePath: string): Promise<StateData> {
  if (!(await fileExists(statePath))) return { kahuna_branch: null };
  return (await readJson(statePath)) as StateData;
}

const waveInitHandler: HandlerDef = {
  name: 'wave_init',
  description:
    'Initialize a wave plan from structured JSON; supports --extend mode. ' +
    'Optional `kahuna` argument bootstraps a `kahuna/<plan_id>-<slug>` branch ' +
    'off the plan\'s base_branch (default `main`) and records it in wave state. ' +
    'Atomic across kahuna bootstrap + plan persist (#378): kahuna failure does ' +
    'not persist the plan; plan-persist failure leaves the branch claimable on retry.',
  inputSchema,
  async execute(rawArgs: unknown) {
    let args: z.infer<typeof inputSchema>;
    try { args = inputSchema.parse(rawArgs); }
    catch (err) { return envelope({ ok: false, error: err instanceof Error ? err.message : String(err) }); }

    const cwd = projectDir(args.project_root);
    args.plan_json = normalizePlanJson(args.plan_json, args.repo);
    if (args.extend) {
      const pre = await extendModePrescan(args.plan_json, cwd);
      if (!pre.ok) return envelope(pre);
    }
    try {
      const plan = JSON.parse(args.plan_json) as PlanData;

      // ---- Step 2: kahuna bootstrap (REMOTE only — no state writes) -------
      // Runs BEFORE plan persist so a kahuna failure doesn't strand state.
      let kahunaBranch: string | undefined;
      let kahunaCreated = false;
      let kahunaPreviouslyRecorded = false;
      if (args.kahuna !== undefined) {
        const slug = args.repo ?? parseRepoSlug() ?? undefined;
        const baseBranch = typeof plan.base_branch === 'string' && plan.base_branch.length > 0 ? plan.base_branch : 'main';
        const statePath = join(await statusDir(cwd), 'state.json');
        const remote = await bootstrapKahunaBranchRemote(cwd, args.kahuna, baseBranch,
          () => readStateOrDefault(statePath),
          {
            adapter: getAdapter({ repo: slug }), slug,
            branchPresentOnRemote: (b) => branchExistsOnRemote(cwd, b),
          });
        if (!remote.ok) return envelope({ ok: false, error: remote.error });
        kahunaBranch = remote.kahuna_branch;
        kahunaCreated = remote.created;
        kahunaPreviouslyRecorded = remote.previously_recorded;
      }

      // ---- Step 3: persist plan to disk -----------------------------------
      const planFile = writePlanFile(args.plan_json);
      const extendFlag = args.extend ? ' --extend' : '';
      const forceFlag = args.force ? ' --force' : '';
      const repoFlag = args.repo ? ` --repo ${shellQuote(args.repo)}` : '';
      execSync(`wave-status init${extendFlag}${forceFlag}${repoFlag} ${planFile}`, { cwd, encoding: 'utf8' });

      const counts = countIssuesFromPlan(plan);
      const totals = await readPhasesWavesTotals(cwd);

      // ---- Step 4: record kahuna branch in state.json ---------------------
      // `set-kahuna-branch` requires state.json (created by step 3). Skipped
      // when state.json already had the matching branch recorded — no work
      // to do, and the `wave-status init` for a fresh init wouldn't have
      // preserved it anyway (only relevant in extend mode).
      let kahuna: { kahuna_branch: string; kahuna_created: boolean } | undefined;
      if (kahunaBranch !== undefined) {
        if (!kahunaPreviouslyRecorded) {
          const recordResult = recordKahunaBranchInState(kahunaBranch,
            (b) => { execSync(`wave-status set-kahuna-branch ${shellQuote(b)}`, { cwd, encoding: 'utf8' }); });
          if (!recordResult.ok) return envelope({ ok: false, error: recordResult.error });
        }
        kahuna = { kahuna_branch: kahunaBranch, kahuna_created: kahunaCreated };
      }

      return envelope({ ok: true, mode: args.extend ? 'extend' : 'init', ...counts, ...totals, ...(kahuna ?? {}) });
    } catch (err) {
      return envelope({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  },
};

export default waveInitHandler;
