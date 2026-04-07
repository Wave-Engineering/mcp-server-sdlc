import { join } from 'path';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';

const inputSchema = z
  .object({
    wave_id: z.string().optional(),
  })
  .strict();

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
  const sdlc = join(root, '.sdlc');
  if (await fileExists(sdlc)) return join(sdlc, 'waves');
  return join(root, '.claude', 'status');
}

interface Deferral {
  status?: string;
  description?: string;
  risk?: string;
}

interface StateData {
  current_wave?: string | null;
  waves?: Record<string, { status?: string }>;
  deferrals?: Deferral[];
}

interface Blocker {
  type: string;
  details: Record<string, unknown>;
}

const waveHealthCheckHandler: HandlerDef = {
  name: 'wave_health_check',
  description: 'Aggregate safety check for wave advancement; returns structured blockers or clean state',
  inputSchema,
  async execute(rawArgs: unknown) {
    let args: z.infer<typeof inputSchema>;
    try {
      args = inputSchema.parse(rawArgs);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error }) }],
      };
    }

    try {
      const dir = await statusDir(projectDir());
      const statePath = join(dir, 'state.json');

      if (!(await fileExists(statePath))) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: `state file not found: ${statePath}`,
              }),
            },
          ],
        };
      }

      const state = (await readJson(statePath)) as StateData;
      const waveId = args.wave_id ?? state.current_wave ?? null;

      const blockers: Blocker[] = [];
      const warnings: Blocker[] = [];

      // Deferral check: any pending deferral blocks advancement.
      for (const d of state.deferrals ?? []) {
        if (d.status === 'pending') {
          blockers.push({
            type: 'deferral',
            details: {
              description: d.description ?? '',
              risk: d.risk ?? 'unknown',
            },
          });
        } else if (d.status === 'accepted') {
          warnings.push({
            type: 'deferral_accepted',
            details: {
              description: d.description ?? '',
              risk: d.risk ?? 'unknown',
            },
          });
        }
      }

      // v1: drift, CI, merge-conflict, and escalation checks are deferred
      // to future stories once the signals are captured in state.json.
      // They appear in the schema so callers can depend on the shape.

      const safeToProceed = blockers.length === 0;
      const summary = safeToProceed
        ? 'clean — no blockers detected'
        : `${blockers.length} blocker(s) detected`;

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              wave_id: waveId,
              safe_to_proceed: safeToProceed,
              blockers,
              warnings,
              summary,
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

export default waveHealthCheckHandler;
