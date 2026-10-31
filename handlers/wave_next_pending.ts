import { join } from 'path';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { computeWaves, type DepNode } from '../lib/dependency_graph.js';
import {
  describeHolds,
  evaluateWaveGate,
  type EcHold,
  type EntryConditions,
  type WaveGate,
} from '../lib/entry-conditions.js';

const inputSchema = z.object({}).strict();

function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
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

interface PlanIssue {
  number: number;
  title?: string;
  /** Entry-condition ids this story is gated on (#613). */
  ec?: unknown;
  depends_on?: unknown;
}

interface PlanWave {
  id: string;
  issues?: PlanIssue[];
  depends_on?: string[];
  topology?: string;
}

interface PlanPhase {
  name?: string;
  waves?: PlanWave[];
}

interface PlanData {
  phases?: PlanPhase[];
  entry_conditions?: EntryConditions;
}

interface StateData {
  waves?: Record<string, { status?: string }>;
}

interface NextPendingResult {
  id: string;
  issues: Array<{ number: number; title: string }>;
  depends_on: string[];
  topology: string | null;
  /** Present only when a `delivery` EC holds this wave's completion (#613). */
  delivery_held_by?: EcHold[];
}

type NextPending =
  | { kind: 'wave'; wave: NextPendingResult }
  | { kind: 'held'; id: string; gate: WaveGate }
  | { kind: 'none' };

// A `held` wave (#613; the state comes from the wave-status side, cc-workflow
// #1393) is a candidate again on every call: the gate is re-evaluated from the
// plan file, so an EC met since the hold releases it, and one still unmet keeps
// it held. It must never be passed over for a later pending wave.
const CANDIDATE_STATUSES = new Set(['pending', 'held']);

function findNextPending(plan: PlanData, state: StateData): NextPending {
  const waves = state.waves ?? {};
  for (const phase of plan.phases ?? []) {
    for (const wave of phase.waves ?? []) {
      const status = waves[wave.id]?.status ?? 'pending';
      if (CANDIDATE_STATUSES.has(status)) {
        const gate = evaluateWaveGate(plan.entry_conditions, wave.issues ?? []);
        if (gate.held) return { kind: 'held', id: wave.id, gate };

        const issues = (wave.issues ?? []).map(i => ({
          number: i.number,
          title: i.title ?? '',
        }));

        let topology: string;
        if (wave.topology != null) {
          // Pass through caller-supplied topology from the plan file as-is.
          topology = wave.topology;
        } else {
          // Fallback classifier sees zero-dep nodes because PlanWave doesn't store
          // per-issue edges. Multi-issue waves without explicit deps will classify as
          // 'parallel'; true 'mixed'/'serial' classification would require fetching
          // issue bodies, which would make this handler network-bound — accept the
          // limitation.
          const nodes: DepNode[] = issues.map(i => ({
            ref: String(i.number),
            depends_on: [],
          }));
          topology = computeWaves(nodes).topology;
        }

        return {
          kind: 'wave',
          wave: {
            id: wave.id,
            issues,
            depends_on: wave.depends_on ?? [],
            topology,
            // Omitted when empty, so a plan with no ECs gets exactly today's shape.
            ...(gate.delivery.length > 0 ? { delivery_held_by: gate.delivery } : {}),
          },
        };
      }
    }
  }
  return { kind: 'none' };
}

const waveNextPendingHandler: HandlerDef = {
  name: 'wave_next_pending',
  description:
    "Return the next pending wave's metadata, or null if no pending waves. Fails closed on entry conditions: " +
    'if any story in that wave names a `start` EC that is not `met` (or undeclared), or a cross-plan `<plan>#<n>` ' +
    'dependency, it returns ok:false with code `wave_held` naming each hold. A `delivery` EC lets the wave start ' +
    'and is reported in `delivery_held_by`.',
  inputSchema,
  async execute(rawArgs: unknown) {
    try {
      inputSchema.parse(rawArgs);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error }) }],
      };
    }

    try {
      const dir = await statusDir(projectDir());
      const planPath = join(dir, 'phases-waves.json');
      const statePath = join(dir, 'state.json');

      if (!(await fileExists(planPath)) || !(await fileExists(statePath))) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: `state files not found in ${dir}`,
              }),
            },
          ],
        };
      }

      const plan = (await readJson(planPath)) as PlanData;
      const state = (await readJson(statePath)) as StateData;
      const next = findNextPending(plan, state);

      // A held wave is a refusal, not `wave: null`. `null` means "no pending
      // waves", which a caller that does not know about holds would read as the
      // campaign being finished. `ok: false` stops it instead (#613).
      const payload =
        next.kind === 'held'
          ? {
              ok: false,
              code: 'wave_held',
              error: describeHolds(next.id, next.gate),
              held: {
                wave: next.id,
                entry_conditions: next.gate.start,
                depends_on: next.gate.depends_on,
              },
            }
          : { ok: true, wave: next.kind === 'wave' ? next.wave : null };

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(payload),
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

export default waveNextPendingHandler;
