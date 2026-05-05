// Wave-init handler — platform-agnostic shell. Platform calls go through
// `getAdapter()`; plan/state helpers live in `lib/wave_init_plan.ts`.
// Story 2.22 (#316).
import { execSync } from 'child_process';
import { join } from 'path';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { parseRepoSlug } from '../lib/shared/parse-repo-slug.js';
import { getAdapter } from '../lib/adapters/index.js';
import {
  projectDir, writePlanFile, statusDir, readJson, countIssuesFromPlan,
  extendModePrescan, readPhasesWavesTotals, bootstrapKahunaBranch,
  branchExistsOnRemote, type PlanData, type StateData,
} from '../lib/wave_init_plan.js';
import { repoOptionalSchema } from '../lib/schemas/repo.js';

const inputSchema = z.object({
  plan_json: z.string().min(1, 'plan_json must be a non-empty JSON string'),
  extend: z.boolean().optional().default(false),
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

const waveInitHandler: HandlerDef = {
  name: 'wave_init',
  description:
    'Initialize a wave plan from structured JSON; supports --extend mode. ' +
    'Optional `kahuna` argument bootstraps a `kahuna/<plan_id>-<slug>` branch ' +
    'off the plan\'s base_branch (default `main`) and records it in wave state.',
  inputSchema,
  async execute(rawArgs: unknown) {
    let args: z.infer<typeof inputSchema>;
    try { args = inputSchema.parse(rawArgs); }
    catch (err) { return envelope({ ok: false, error: err instanceof Error ? err.message : String(err) }); }

    const cwd = projectDir(args.project_root);
    if (args.extend) {
      const pre = await extendModePrescan(args.plan_json, cwd);
      if (!pre.ok) return envelope(pre);
    }
    try {
      const planFile = writePlanFile(args.plan_json);
      const extendFlag = args.extend ? ' --extend' : '';
      const repoFlag = args.repo ? ` --repo ${shellQuote(args.repo)}` : '';
      execSync(`wave-status init${extendFlag}${repoFlag} ${planFile}`, { cwd, encoding: 'utf8' });

      const plan = JSON.parse(args.plan_json) as PlanData;
      const counts = countIssuesFromPlan(plan);
      const totals = await readPhasesWavesTotals(cwd);

      let kahuna: { kahuna_branch: string; kahuna_created: boolean } | undefined;
      if (args.kahuna !== undefined) {
        const baseBranch = typeof plan.base_branch === 'string' && plan.base_branch.length > 0 ? plan.base_branch : 'main';
        const statePath = join(await statusDir(cwd), 'state.json');
        const slug = args.repo ?? parseRepoSlug() ?? undefined;
        const result = await bootstrapKahunaBranch(cwd, args.kahuna, baseBranch,
          async () => (await readJson(statePath)) as StateData,
          {
            adapter: getAdapter({ repo: slug }), slug,
            recordKahunaBranch: (b) => { execSync(`wave-status set-kahuna-branch ${shellQuote(b)}`, { cwd, encoding: 'utf8' }); },
            branchPresentOnRemote: (b) => branchExistsOnRemote(cwd, b),
          });
        if (!result.ok) return envelope({ ok: false, error: result.error });
        kahuna = { kahuna_branch: result.kahuna_branch, kahuna_created: result.created };
      }

      return envelope({ ok: true, mode: args.extend ? 'extend' : 'init', ...counts, ...totals, ...(kahuna ?? {}) });
    } catch (err) {
      return envelope({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  },
};

export default waveInitHandler;
