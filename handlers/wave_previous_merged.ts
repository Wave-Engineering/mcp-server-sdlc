import { execSync } from 'child_process';
import { join } from 'path';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';

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
  const sdlc = join(root, '.sdlc');
  if (await fileExists(sdlc)) return join(sdlc, 'waves');
  return join(root, '.claude', 'status');
}

function detectPlatform(): 'github' | 'gitlab' {
  try {
    const url = execSync('git remote get-url origin', { encoding: 'utf8' }).trim();
    return url.includes('github') ? 'github' : 'gitlab';
  } catch {
    return 'github';
  }
}

interface PlanIssue {
  number: number;
}
interface PlanWave {
  id: string;
  issues?: PlanIssue[];
}
interface PlanPhase {
  waves?: PlanWave[];
}
interface PlanData {
  phases?: PlanPhase[];
}

interface WaveState {
  status?: string;
}

interface StateData {
  current_wave?: string | null;
  waves?: Record<string, WaveState>;
}

function flatWaveIds(plan: PlanData): string[] {
  const ids: string[] = [];
  for (const phase of plan.phases ?? []) {
    for (const wave of phase.waves ?? []) {
      ids.push(wave.id);
    }
  }
  return ids;
}

function findWave(plan: PlanData, id: string): PlanWave | null {
  for (const phase of plan.phases ?? []) {
    for (const wave of phase.waves ?? []) {
      if (wave.id === id) return wave;
    }
  }
  return null;
}

function findPreviousWaveId(plan: PlanData, state: StateData): string | null {
  const ids = flatWaveIds(plan);
  const current = state.current_wave;

  // If current_wave is set, previous is the one before it.
  if (current) {
    const idx = ids.indexOf(current);
    return idx > 0 ? ids[idx - 1] : null;
  }

  // If no current_wave, use the latest wave with status=completed.
  const waves = state.waves ?? {};
  for (let i = ids.length - 1; i >= 0; i--) {
    if (waves[ids[i]]?.status === 'completed') return ids[i];
  }
  return null;
}

interface GhIssueState {
  state: string;
  stateReason?: string;
}

function fetchGithubIssueState(n: number): GhIssueState {
  const raw = execSync(`gh issue view ${n} --json state,stateReason`, { encoding: 'utf8' });
  const parsed = JSON.parse(raw) as { state: string; stateReason?: string };
  return { state: parsed.state.toUpperCase(), stateReason: parsed.stateReason };
}

function fetchGitlabIssueState(n: number): GhIssueState {
  const raw = execSync(`glab issue view ${n} --output json`, { encoding: 'utf8' });
  const parsed = JSON.parse(raw) as { state: string };
  const state = parsed.state === 'opened' ? 'OPEN' : parsed.state.toUpperCase();
  return { state };
}

const wavePreviousMergedHandler: HandlerDef = {
  name: 'wave_previous_merged',
  description: "Verify the previous wave's issues are all closed via merged PRs",
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

      const prevId = findPreviousWaveId(plan, state);
      if (!prevId) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: true,
                previous_wave_id: null,
                all_merged: true,
                open_issues: [],
              }),
            },
          ],
        };
      }

      const prevWave = findWave(plan, prevId);
      if (!prevWave) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: `previous wave '${prevId}' not found in plan`,
              }),
            },
          ],
        };
      }

      const platform = detectPlatform();
      const openIssues: number[] = [];

      for (const issue of prevWave.issues ?? []) {
        try {
          const info =
            platform === 'github'
              ? fetchGithubIssueState(issue.number)
              : fetchGitlabIssueState(issue.number);
          if (info.state !== 'CLOSED') {
            openIssues.push(issue.number);
          }
        } catch {
          openIssues.push(issue.number);
        }
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              previous_wave_id: prevId,
              all_merged: openIssues.length === 0,
              open_issues: openIssues,
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

export default wavePreviousMergedHandler;
