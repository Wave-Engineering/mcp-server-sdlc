import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';

const inputSchema = z.object({
  plan_json: z.string().min(1, 'plan_json must be a non-empty JSON string'),
  extend: z.boolean().optional().default(false),
  project_root: z.string().optional(),
  repo: z
    .string()
    .regex(/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/, 'repo must be owner/repo format')
    .optional(),
});

type Input = z.infer<typeof inputSchema>;

interface PlanWave {
  id?: string;
  issues?: unknown[];
}

interface PlanPhase {
  waves?: PlanWave[];
}

interface PlanData {
  phases?: PlanPhase[];
}

interface StateData {
  waves?: Record<string, unknown>;
}

interface PhasesWavesData {
  phases?: Array<{ waves?: unknown[] }>;
}

function projectDir(override?: string): string {
  if (override !== undefined && override.length > 0) return override;
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

function writePlanFile(planJson: string): string {
  const path = `/tmp/wave-init-plan-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`;
  writeFileSync(path, planJson);
  return path;
}

async function fileExists(path: string): Promise<boolean> {
  return await Bun.file(path).exists();
}

async function readJson(path: string): Promise<unknown> {
  return await Bun.file(path).json();
}

async function statusDir(root: string): Promise<string> {
  // Prefer .sdlc/waves/ if .sdlc/ exists; otherwise fall back to .claude/status/.
  const sdlc = join(root, '.sdlc');
  if (await fileExists(sdlc)) return join(sdlc, 'waves');
  return join(root, '.claude', 'status');
}

function countIssuesFromPlan(plan: PlanData): {
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

function extractPlanWaveIds(plan: PlanData): string[] {
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

const waveInitHandler: HandlerDef = {
  name: 'wave_init',
  description: 'Initialize a wave plan from structured JSON; supports --extend mode',
  inputSchema,
  async execute(rawArgs: unknown) {
    let args: Input;
    try {
      args = inputSchema.parse(rawArgs);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error }) }],
      };
    }

    // Extend-mode collision pre-scan: defense in depth on top of the CLI's
    // own collision guard. Parse the plan, read the existing state file, and
    // refuse before touching the CLI if any wave IDs already exist.
    if (args.extend) {
      let planParsed: PlanData;
      try {
        planParsed = JSON.parse(args.plan_json) as PlanData;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: `plan_json is not valid JSON: ${detail}`,
              }),
            },
          ],
        };
      }

      try {
        const dir = await statusDir(projectDir(args.project_root));
        const statePath = join(dir, 'state.json');

        if (!(await fileExists(statePath))) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ ok: false, error: 'no existing plan found' }),
              },
            ],
          };
        }

        const state = (await readJson(statePath)) as StateData;
        const existingIds = new Set(Object.keys(state.waves ?? {}));
        const incomingIds = extractPlanWaveIds(planParsed);
        const colliding = incomingIds.filter(id => existingIds.has(id));

        if (colliding.length > 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  ok: false,
                  error: `wave ID collision: ${colliding.join(', ')} already exist`,
                  colliding_ids: colliding,
                }),
              },
            ],
          };
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error }) }],
        };
      }
    }

    try {
      const planFile = writePlanFile(args.plan_json);
      const extendFlag = args.extend ? ' --extend' : '';
      // Single-quote the repo value before interpolating into the shell
      // string. The Zod regex already restricts the character set to shell-
      // safe chars, but explicit quoting is defense-in-depth + consistent
      // with how issue_ref and mr_ref are handled in the other wave handlers.
      const repoFlag = args.repo
        ? ` --repo '${args.repo.replace(/'/g, `'\\''`)}'`
        : '';
      const cmd = `wave-status init${extendFlag}${repoFlag} ${planFile}`;
      execSync(cmd, {
        cwd: projectDir(args.project_root),
        encoding: 'utf8',
      });

      // Rich success payload: count what the plan added, then re-read the
      // phases-waves.json the CLI just wrote to report project totals.
      const planParsed = JSON.parse(args.plan_json) as PlanData;
      const { phases_added, waves_added, issues_added } = countIssuesFromPlan(planParsed);

      let total_phases = 0;
      let total_waves = 0;
      try {
        const dir = await statusDir(projectDir(args.project_root));
        const phasesPath = join(dir, 'phases-waves.json');
        if (await fileExists(phasesPath)) {
          const phasesData = (await readJson(phasesPath)) as PhasesWavesData;
          const phases = phasesData.phases ?? [];
          total_phases = phases.length;
          for (const p of phases) {
            total_waves += (p.waves ?? []).length;
          }
        }
      } catch {
        // If the phases file can't be read, leave totals at 0 rather than
        // failing the whole call — the CLI already succeeded.
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              mode: args.extend ? 'extend' : 'init',
              phases_added,
              waves_added,
              issues_added,
              total_phases,
              total_waves,
            }),
          },
        ],
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error }) }],
      };
    }
  },
};

export default waveInitHandler;
