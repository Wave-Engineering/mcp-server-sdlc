// wave_ec_sync — write the latest entry-condition state from the Plan issue's
// `[ec-state EC-n] met|unmet|reclosed` comments into `phases-waves.json` (#613).
//
// Hybrid handler: the one platform call (`issueComments`) is in the adapter;
// parsing and merging are in `lib/entry-conditions.ts`; this file owns only the
// plan-file read and write.
//
// Only ECs the plan declares are written, and each keeps its declared `gates`.
// A declared EC with no comment is written `unmet`. Nothing here decides
// whether a wave may start — `wave_next_pending` evaluates the gate from the
// file on every call, so a sync is never needed to make a gate stricter, only
// to record that an EC has been met.

import { rename } from 'node:fs/promises';
import { join } from 'path';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { getAdapter } from '../lib/adapters/index.js';
import { repoOptionalSchema } from '../lib/schemas/repo.js';
import {
  canonicalEcId,
  parseEcStateComments,
  syncEntryConditions,
  type EntryConditions,
} from '../lib/entry-conditions.js';

const inputSchema = z.object({
  plan_issue: z.number().int().positive().optional(),
  repo: repoOptionalSchema,
  dry_run: z.boolean().optional().default(false),
});

interface PlanFile {
  plan_id?: number;
  plan_issue?: string;
  project?: string;
  repo?: string;
  entry_conditions?: EntryConditions;
  phases?: Array<{ waves?: Array<{ issues?: Array<{ number?: number; ec?: unknown }> }> }>;
  [key: string]: unknown;
}

function envelope(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

async function statusDir(root: string): Promise<string> {
  // Prefer .sdlc/waves/ if .sdlc/ exists; otherwise fall back to .claude/status/.
  const sdlc = join(root, '.sdlc');
  if (await Bun.file(sdlc).exists()) return join(sdlc, 'waves');
  return join(root, '.claude', 'status');
}

/** `#12` or `owner/repo#12` → its parts; anything else → null. */
function parsePlanIssueRef(ref: unknown): { number: number; repo?: string } | null {
  if (typeof ref !== 'string') return null;
  const m = /^(?:([^\s#]+\/[^\s#]+))?#(\d+)$/.exec(ref.trim());
  if (!m) return null;
  return { number: Number(m[2]), ...(m[1] ? { repo: m[1] } : {}) };
}

/** EC ids that some issue names but the plan does not declare. */
function undeclaredReferences(plan: PlanFile): Array<{ ec: string; issues: number[] }> {
  // Matched by canonical id, as the gate matches them: a story's `EC-01` is a declared `EC-1`.
  const declared = new Set(Object.keys(plan.entry_conditions ?? {}).map(canonicalEcId));
  const found = new Map<string, number[]>();
  for (const phase of plan.phases ?? []) {
    for (const wave of phase.waves ?? []) {
      for (const issue of wave.issues ?? []) {
        if (!Array.isArray(issue.ec)) continue;
        for (const ec of issue.ec) {
          if (typeof ec !== 'string' || declared.has(canonicalEcId(ec))) continue;
          const list = found.get(ec) ?? [];
          if (typeof issue.number === 'number') list.push(issue.number);
          found.set(ec, list);
        }
      }
    }
  }
  return [...found.entries()].map(([ec, issues]) => ({ ec, issues }));
}

const waveEcSyncHandler: HandlerDef = {
  name: 'wave_ec_sync',
  description:
    'Sync entry-condition (EC) state from the Plan issue\'s `[ec-state EC-n] met|unmet|reclosed` comments into ' +
    'phases-waves.json `entry_conditions`. The latest comment per EC wins; a declared EC with no comment or an ' +
    'unparseable state is written `unmet`. Only declared ECs are written. Lines from authors without write ' +
    'access are ignored and listed in `untrusted`. The Plan issue defaults to the plan file\'s `plan_id` / ' +
    '`plan_issue`; if both are set and disagree it refuses with `ambiguous_plan_issue`. Cross-platform (gh + glab).',
  inputSchema,
  async execute(rawArgs: unknown) {
    let args;
    try {
      args = inputSchema.parse(rawArgs);
    } catch (err) {
      return envelope({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }

    let planPath: string;
    let plan: PlanFile;
    try {
      planPath = join(await statusDir(projectDir()), 'phases-waves.json');
      if (!(await Bun.file(planPath).exists())) {
        return envelope({ ok: false, code: 'plan_not_found', error: `plan file not found: ${planPath}` });
      }
      plan = (await Bun.file(planPath).json()) as PlanFile;
    } catch (err) {
      return envelope({ ok: false, code: 'plan_unreadable', error: err instanceof Error ? err.message : String(err) });
    }

    // The number and the repo are resolved as a pair, from one source, so a
    // number from one place is never read against a repo from another. An
    // explicit `plan_issue` names an issue in `repo` or the plan's own project;
    // the file's `plan_issue` ref carries its own repo.
    const fromRef = parsePlanIssueRef(plan.plan_issue);
    const ownRepo = plan.project ?? plan.repo;
    let number: number | undefined;
    let repo: string | undefined;
    if (args.plan_issue !== undefined) {
      number = args.plan_issue;
      repo = args.repo ?? ownRepo;
    } else {
      if (plan.plan_id !== undefined && fromRef !== null && fromRef.number !== plan.plan_id) {
        return envelope({
          ok: false,
          code: 'ambiguous_plan_issue',
          error: `phases-waves.json names two Plan issues: plan_id ${String(plan.plan_id)} and plan_issue ${JSON.stringify(plan.plan_issue)}; pass \`plan_issue\` to choose`,
        });
      }
      if (args.repo !== undefined && fromRef?.repo !== undefined && args.repo !== fromRef.repo) {
        return envelope({
          ok: false,
          code: 'ambiguous_plan_issue',
          error: `\`repo\` ${JSON.stringify(args.repo)} disagrees with the plan file's plan_issue ${JSON.stringify(plan.plan_issue)}; pass \`plan_issue\` with \`repo\` to choose`,
        });
      }
      number = plan.plan_id ?? fromRef?.number;
      repo = fromRef?.repo ?? args.repo ?? ownRepo;
    }
    if (number === undefined) {
      return envelope({
        ok: false,
        code: 'no_plan_issue',
        error: 'no Plan issue: pass `plan_issue`, or set `plan_id` / `plan_issue` in phases-waves.json',
      });
    }

    const result = await getAdapter({ repo }).issueComments({ number, repo });
    if ('platform_unsupported' in result) {
      return envelope({ ok: false, error: result.hint });
    }
    if (!result.ok) return envelope({ ok: false, code: result.code, error: result.error });

    const parsed = parseEcStateComments(result.data.comments);
    const report = syncEntryConditions(plan.entry_conditions, parsed);
    const declaredCount = Object.keys(plan.entry_conditions ?? {}).length;

    // A plan with no declared ECs is left byte-for-byte untouched.
    let written = false;
    if (!args.dry_run && declaredCount > 0) {
      try {
        const next: PlanFile = { ...plan, entry_conditions: report.entry_conditions };
        const tmp = `${planPath}.ec-sync-${process.pid}-${Date.now()}.tmp`;
        await Bun.write(tmp, `${JSON.stringify(next, null, 2)}\n`);
        await rename(tmp, planPath);
        written = true;
      } catch (err) {
        return envelope({
          ok: false,
          code: 'plan_write_failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return envelope({
      ok: true,
      plan_issue: number,
      written,
      dry_run: args.dry_run,
      entry_conditions: report.entry_conditions,
      changed: report.changed,
      no_comment: report.no_comment,
      undeclared_in_comments: report.undeclared_in_comments,
      undeclared_in_plan: undeclaredReferences(plan),
      malformed: parsed.malformed,
      untrusted: parsed.untrusted,
    });
  },
};

export default waveEcSyncHandler;
