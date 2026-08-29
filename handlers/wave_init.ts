// Wave-init handler — platform-agnostic shell. Platform calls go through
// `getAdapter()`; plan/state helpers live in `lib/wave_init_plan.ts`.
// Story 2.22 (#316).
//
// Atomicity guarantee (#378, extended #406). The handler interleaves the
// kahuna bootstrap around the `wave-status init` plan-persist call so a failure
// at ANY step leaves only a half-state that a plain retry can recover — no
// `--force`, no `extend: true`. Sequence:
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
// Failure semantics (every step is retry-safe — full atomicity):
// - Step 2 fails → no plan persisted. Retry converges trivially.
// - Step 3 fails → branch exists on remote, no plan on disk. Retry's step 2
//   sees the existing branch and claims it as idempotent reuse (see the
//   "recorded === null + branch present" path in `bootstrapKahunaBranchRemote`),
//   then proceeds to run step 3.
// - Step 4 fails → plan IS persisted AND branch is on remote, but state.json's
//   kahuna_branch is still null (#406). A naive retry would re-enter step 2
//   (claim the branch) then step 3 (`wave-status init` WITHOUT --extend),
//   REINITIALIZING the persisted plan. The handler detects this half-state
//   before step 3 — plan fully persisted + branch claimed via reuse + state
//   unrecorded — and SKIPS step 3, jumping straight to step 4 to record the
//   branch. The retry needs no `--force` or `extend: true`.
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
    // #503: the integration branch name, supplied by the caller. Omit it and the
    // historical `kahuna/<plan_id>-<slug>` is derived — correct for a standalone
    // single-wave run, wrong for a campaign, where the branch must be per-WAVE and
    // cut from the campaign branch rather than per-plan and cut from trunk. Only the
    // caller knows which of those it is running, so only the caller can name it.
    branch: z.string().min(1).optional(),
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
    'Optional `kahuna` argument bootstraps an integration branch off the plan\'s base_branch ' +
    '(default: the repo\'s live default branch) and records it in wave state. ' +
    'The branch is `kahuna.branch` verbatim when supplied, else the derived `kahuna/<plan_id>-<slug>`; ' +
    'pass it explicitly for a campaign, where the branch must be per-wave and cut from the ' +
    'campaign branch rather than per-plan and cut from trunk (#503). ' +
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
        const adapter = getAdapter({ repo: slug });
        const resolveDefault = async (): Promise<
          { ok: true; branch: string } | { ok: false; error: string; code?: string }
        > => {
          const defRes = await adapter.resolveDefaultBranch({ repo: slug, cwd });
          if ('platform_unsupported' in defRes) {
            // platform_unsupported carries a hint, not a typed code — no code to thread.
            return { ok: false, error: `default-branch resolution unsupported: ${defRes.hint}` };
          }
          // #527: thread the adapter's typed code through the wrapper so the
          // relays below can preserve it instead of collapsing to {ok,error}.
          if (!defRes.ok) return { ok: false, error: defRes.error, code: defRes.code };
          return { ok: true, branch: defRes.data.default_branch };
        };
        // Base branch: the plan's explicit base_branch wins; otherwise resolve the
        // LIVE default branch from the host (never hardcode 'main' — a repo whose
        // default is e.g. release/1.0.0 would otherwise cut the kahuna branch from
        // the wrong place). Mirrors how pr_create defaults its base.
        //
        // `defaultBranch` is tracked SEPARATELY from `baseBranch` because the two
        // diverge exactly when it matters: an explicit base means the protected
        // branch is some other ref, and that other ref is the one an integration
        // branch must never be (#503).
        let baseBranch: string;
        let defaultBranch: string | undefined;
        if (typeof plan.base_branch === 'string' && plan.base_branch.length > 0) {
          baseBranch = plan.base_branch;
          // The base is explicit, so the default branch is a DIFFERENT ref and the
          // bootstrap's "never equal to the protected branch" guard needs it. Only
          // worth the extra host call when the caller named the branch: a derived
          // `kahuna/<id>-<slug>` cannot collide with a plausible default (#503).
          if (args.kahuna.branch !== undefined) {
            const defRes = await resolveDefault();
            // Fail loud rather than proceed with the guard disabled — a bootstrap that
            // silently skips its trunk check is the failure mode this guard exists for.
            if (!defRes.ok) return envelope({ ok: false, code: defRes.code, error: defRes.error });
            defaultBranch = defRes.branch;
          }
        } else {
          const defRes = await resolveDefault();
          if (!defRes.ok) return envelope({ ok: false, code: defRes.code, error: defRes.error });
          baseBranch = defRes.branch;
          defaultBranch = defRes.branch; // same ref — the guard's base check covers it
        }
        const statePath = join(await statusDir(cwd), 'state.json');
        const remote = await bootstrapKahunaBranchRemote(cwd, args.kahuna, baseBranch,
          () => readStateOrDefault(statePath),
          {
            adapter, slug,
            branchPresentOnRemote: (b) => branchExistsOnRemote(cwd, b),
          },
          defaultBranch);
        if (!remote.ok) return envelope({ ok: false, error: remote.error });
        kahunaBranch = remote.kahuna_branch;
        kahunaCreated = remote.created;
        kahunaPreviouslyRecorded = remote.previously_recorded;
      }

      // ---- Step-4-failure half-state resume (#406) ------------------------
      // A prior run can fail at Step 4 (`set-kahuna-branch`) AFTER Steps 2 and
      // 3 both succeeded: the plan is fully persisted (state.json +
      // phases-waves.json on disk) AND the branch is on the remote, but
      // state.json's kahuna_branch is still null. In that case Step 2 above
      // just re-claimed the orphan branch via the reuse path — i.e. we neither
      // created it (`!kahunaCreated`) nor found it already recorded in state
      // (`!kahunaPreviouslyRecorded`). Re-running `wave-status init` (non-extend)
      // would REINITIALIZE the persisted plan, so detect the half-state and skip
      // Step 3, jumping straight to Step 4 to record the branch. Non-extend only:
      // an --extend retry legitimately adds new waves and must run its init — and
      // an explicit `--force` must REINITIALIZE, so it likewise bypasses the
      // resume-skip: an operator (e.g. wave_campaign_precheck's `replace` recovery,
      // #466) passing force:true wants the stale on-disk plan overwritten, not
      // silently preserved. Omitting !args.force here downgrades force to a no-op.
      let planAlreadyPersisted = false;
      if (kahunaBranch !== undefined && !args.extend && !args.force && !kahunaCreated && !kahunaPreviouslyRecorded) {
        const dir = await statusDir(cwd);
        planAlreadyPersisted =
          (await fileExists(join(dir, 'phases-waves.json'))) &&
          (await fileExists(join(dir, 'state.json')));
      }

      // ---- Step 3: persist plan to disk (skipped on a Step-4 resume) -------
      if (!planAlreadyPersisted) {
        const planFile = writePlanFile(args.plan_json);
        const extendFlag = args.extend ? ' --extend' : '';
        const forceFlag = args.force ? ' --force' : '';
        const repoFlag = args.repo ? ` --repo ${shellQuote(args.repo)}` : '';
        execSync(`wave-status init${extendFlag}${forceFlag}${repoFlag} ${planFile}`, { cwd, encoding: 'utf8' });
      }

      // A resume added nothing this call — the plan was persisted by the prior
      // run — so report zero deltas; totals still reflect what is on disk.
      const counts = planAlreadyPersisted
        ? { phases_added: 0, waves_added: 0, issues_added: 0 }
        : countIssuesFromPlan(plan);
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

      return envelope({
        ok: true,
        mode: args.extend ? 'extend' : 'init',
        ...(planAlreadyPersisted ? { resumed: 'step4' } : {}),
        ...counts, ...totals, ...(kahuna ?? {}),
      });
    } catch (err) {
      return envelope({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  },
};

export default waveInitHandler;
