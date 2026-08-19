// Prime(post-wave) reconciliation — Category B drift detection per Dev Spec
// §5.4.1. Compares expected-vs-actual story completion for a wave; if any of
// Missing / Unexpected / Dependency-violations is non-empty, posts a canonical
// `[drift-halt]` comment on the Plan tracking issue via the platform adapter.
//
// Sibling relationship:
//   - `wave_reconcile_mrs` — OLDER, MR-backfill handler (populates mr_urls).
//     NOT related to drift detection. Kept separate.
//   - `wave_reconcile`     — THIS file, Category B drift detection.
//   - `wave_previous_merged` — checks prior wave closed cleanly; different
//     scope but similar plan/state-parsing pattern.
//
// Call site: invoked by `/nextwave`'s post-wave hook once the final Flight
// returns. See Dev Spec §5.4.1 for the full envelope (deferrals exclude,
// foundation-wave skip, absent depends_on = skipped).

import { join } from 'path';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { parseRepoSlug } from '../lib/shared/parse-repo-slug.js';
import { getAdapter as defaultGetAdapter } from '../lib/adapters/index.js';
import type { PlatformAdapter } from '../lib/adapters/index.js';
import {
  projectDir, fileExists, readJson, statusDir,
  findWave, waveIssues, deferredIssueNumbers,
  issueNumberFromBranch, computeDriftSets, hasDrift, renderDriftHaltComment,
  type PlanData, type StateData,
} from '../lib/wave-reconcile.js';
import { repoOptionalSchema } from '../lib/schemas/repo.js';

const inputSchema = z.object({
  wave_id: z.string().optional(),
  plan_issue_number: z.number().int().positive().optional(),
  kahuna_branch: z.string().optional(),
  timestamp: z.string().optional(),
  // GitLab nested groups need arbitrary `/` depth — see lib/schemas/repo.ts (#290).
  repo: repoOptionalSchema,
  /**
   * Dry-run: compute drift but skip the `pr_comment` side-effect. Test
   * convenience + future support for a `/wave-reconcile --dry-run` CLI.
   */
  dry_run: z.boolean().optional().default(false),
  /** PR list scan cap. Matches `wave_reconcile_mrs` default of 100. */
  limit: z.number().int().positive().optional().default(100),
}).strict();

/**
 * Injection seam for tests. Same pattern as `wave_reconcile_mrs` — lets the
 * unit tests stub the platform adapter without resorting to a
 * `mock.module('../lib/adapters/index.js', ...)` call, which is known to leak
 * across Bun's test-runner worker boundary and trash sibling adapter tests.
 */
export interface Deps {
  getAdapter: (args?: { repo?: string }) => PlatformAdapter;
}
const defaultDeps: Deps = { getAdapter: defaultGetAdapter };

function envelope(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

/** Derive plan_issue_number from plan.plan_issue ("owner/repo#N") or plan.plan_id. */
function planIssueNumberFromPlan(plan: PlanData): number | null {
  if (typeof plan.plan_id === 'number' && plan.plan_id > 0) return plan.plan_id;
  const m = typeof plan.plan_issue === 'string' ? /#(\d+)$/.exec(plan.plan_issue) : null;
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Core reconciliation logic — extracted from the handler's `execute` so tests
 * can drive it directly with an injected adapter. The handler shell below
 * wraps this for the MCP envelope + default-deps dispatch.
 */
export async function reconcile(
  rawArgs: unknown,
  deps: Deps = defaultDeps,
): Promise<Record<string, unknown>> {
  let args: z.infer<typeof inputSchema>;
  try { args = inputSchema.parse(rawArgs); }
  catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }

  try {
    const dir = await statusDir(projectDir());
    const planPath = join(dir, 'phases-waves.json');
    const statePath = join(dir, 'state.json');
    if (!(await fileExists(planPath)) || !(await fileExists(statePath))) {
      return { ok: false, error: `state files not found in ${dir}` };
    }

    const plan = (await readJson(planPath)) as PlanData;
    const state = (await readJson(statePath)) as StateData;
    const waveId = args.wave_id ?? state.current_wave ?? '';
    if (!waveId) return { ok: false, error: 'no wave_id provided and no current wave set' };

    const wave = findWave(plan, waveId);
    if (!wave) return { ok: false, error: `wave '${waveId}' not found in plan` };

    const issues = waveIssues(wave);
    const expected = issues.map((i) => i.number);
    const deferred = deferredIssueNumbers(state, waveId);

    // Query merged PRs scoped to the kahuna branch.
    const slug = args.repo ?? plan.repo ?? parseRepoSlug() ?? undefined;
    const kahunaBranch = args.kahuna_branch ?? state.kahuna_branch ?? undefined;
    const adapter = deps.getAdapter({ repo: slug });
    const prListRes = await adapter.prList({
      base: kahunaBranch, state: 'merged', limit: args.limit, repo: slug,
    });

    const actual: number[] = [];
    if ('platform_unsupported' in prListRes) {
      return { ok: true, platform_unsupported: true, hint: prListRes.hint };
    }
    if (!prListRes.ok) {
      return { ok: false, code: prListRes.code, error: `pr_list failed: ${prListRes.error}` };
    }
    // Oldest-first for stable merge-order derivation. `pr_list` doesn't
    // guarantee ordering; the adapter's default (GitHub) is newest-first by
    // createdAt. Reverse to approximate merge order — this is a best-effort
    // heuristic and §5.4.1 accepts a conservative pass when merge order
    // isn't available (see computeDriftSets).
    const mergedPrs = [...prListRes.data.prs].reverse();
    for (const pr of mergedPrs) {
      const n = issueNumberFromBranch(pr.head);
      if (n !== null && expected.includes(n)) actual.push(n);
    }
    // De-dupe while preserving order.
    const seen = new Set<number>();
    const actualMergeOrder = actual.filter((n) => (seen.has(n) ? false : (seen.add(n), true)));

    const sets = computeDriftSets({
      expected, actual: actualMergeOrder, deferred, issues, actualMergeOrder,
    });

    if (!hasDrift(sets)) {
      return { ok: true, wave_id: waveId, drift: false, sets };
    }

    // Drift detected — post `[drift-halt]` on Plan issue.
    const planIssueNumber = args.plan_issue_number ?? planIssueNumberFromPlan(plan);
    if (planIssueNumber === null) {
      return {
        ok: false,
        error: 'drift detected but no plan_issue_number provided and plan has no plan_id/plan_issue',
        wave_id: waveId, drift: true, sets,
      };
    }

    const timestamp = args.timestamp ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const body = renderDriftHaltComment({ timestamp, waveId, plan, sets });

    if (args.dry_run) {
      return {
        ok: true, wave_id: waveId, drift: true, sets, dry_run: true,
        plan_issue_number: planIssueNumber, comment_body: body,
      };
    }

    const commentRes = await adapter.prComment({ number: planIssueNumber, body, repo: slug });
    if ('platform_unsupported' in commentRes) {
      return {
        ok: true, wave_id: waveId, drift: true, sets,
        platform_unsupported: true, hint: commentRes.hint,
        comment_body: body,
      };
    }
    if (!commentRes.ok) {
      return {
        ok: false, code: commentRes.code, error: `pr_comment failed: ${commentRes.error}`,
        wave_id: waveId, drift: true, sets, comment_body: body,
      };
    }

    return {
      ok: true, wave_id: waveId, drift: true, sets,
      plan_issue_number: planIssueNumber, comment: commentRes.data,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const waveReconcileHandler: HandlerDef = {
  name: 'wave_reconcile',
  description:
    'Prime(post-wave) Category B drift detection. Reconciles expected-vs-actual story ' +
    'completion for a wave. If Missing/Unexpected/Dependency-violations is non-empty, ' +
    'posts a canonical [drift-halt] comment on the Plan tracking issue per Dev Spec §5.4.1. ' +
    'Call site: /nextwave post-wave hook.',
  inputSchema,
  async execute(rawArgs: unknown) { return envelope(await reconcile(rawArgs)); },
};

export default waveReconcileHandler;
