import { join } from 'path';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { computeWaves, type DepNode } from '../lib/dependency_graph.js';

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
}

interface StateData {
  waves?: Record<string, { status?: string }>;
}

interface NextPendingResult {
  id: string;
  issues: Array<{ number: number; title: string }>;
  depends_on: string[];
  topology: string | null;
}

function findNextPending(plan: PlanData, state: StateData): NextPendingResult | null {
  const waves = state.waves ?? {};
  for (const phase of plan.phases ?? []) {
    for (const wave of phase.waves ?? []) {
      const status = waves[wave.id]?.status ?? 'pending';
      if (status === 'pending') {
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
          id: wave.id,
          issues,
          depends_on: wave.depends_on ?? [],
          topology,
        };
      }
    }
  }
  return null;
}

const waveNextPendingHandler: HandlerDef = {
  name: 'wave_next_pending',
  description: "Return the next pending wave's metadata, or null if no pending waves",
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

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ ok: true, wave: next }),
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
