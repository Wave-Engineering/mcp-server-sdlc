import { execSync } from 'child_process';
import { join } from 'path';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { detectPlatform } from '../lib/glab';

const inputSchema = z.object({
  wave_id: z.string().optional(),
});

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
  mr_urls?: Record<string, string>;
}

interface StateData {
  current_wave?: string | null;
  waves?: Record<string, WaveState>;
}

function findWave(plan: PlanData, id: string): PlanWave | null {
  for (const phase of plan.phases ?? []) {
    for (const wave of phase.waves ?? []) {
      if (wave.id === id) return wave;
    }
  }
  return null;
}

function quoteArg(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

interface Reconciled {
  issue_number: number;
  mr_ref: string;
}

/** Injection seam for tests — allows mocking execSync. */
export interface Deps {
  execFn: (cmd: string) => string;
}

const defaultDeps: Deps = {
  execFn: (cmd: string) => execSync(cmd, { encoding: 'utf8' }).trim(),
};

function queryGithubMergedPrs(
  issueNumber: number,
  deps: Deps,
): string | null {
  try {
    const raw = deps.execFn(
      `gh pr list --state merged --json number,url,headRefName --limit 50`,
    );
    const prs = JSON.parse(raw) as Array<{
      number: number;
      url: string;
      headRefName: string;
    }>;
    const prefix = `feature/${issueNumber}-`;
    const match = prs.find((pr) => pr.headRefName.startsWith(prefix));
    return match ? match.url : null;
  } catch {
    return null;
  }
}

function queryGitlabMergedMrs(
  issueNumber: number,
  deps: Deps,
): string | null {
  try {
    const raw = deps.execFn(
      `glab mr list --state merged --output json`,
    );
    const mrs = JSON.parse(raw) as Array<{
      iid: number;
      web_url: string;
      source_branch: string;
    }>;
    const prefix = `feature/${issueNumber}-`;
    const match = mrs.find((mr) => mr.source_branch.startsWith(prefix));
    return match ? match.web_url : null;
  } catch {
    return null;
  }
}

export async function reconcile(
  rawArgs: unknown,
  deps: Deps = defaultDeps,
): Promise<{
  ok: boolean;
  wave_id: string;
  reconciled: Reconciled[];
  already_recorded: number;
  not_found: number[];
  error?: string;
}> {
  const args = inputSchema.parse(rawArgs);
  const dir = await statusDir(projectDir());
  const planPath = join(dir, 'phases-waves.json');
  const statePath = join(dir, 'state.json');

  if (!(await fileExists(planPath)) || !(await fileExists(statePath))) {
    return {
      ok: false,
      wave_id: '',
      reconciled: [],
      already_recorded: 0,
      not_found: [],
      error: `state files not found in ${dir}`,
    };
  }

  const plan = (await readJson(planPath)) as PlanData;
  const state = (await readJson(statePath)) as StateData;

  const waveId = args.wave_id ?? state.current_wave ?? '';
  if (!waveId) {
    return {
      ok: false,
      wave_id: '',
      reconciled: [],
      already_recorded: 0,
      not_found: [],
      error: 'no wave_id provided and no current wave set',
    };
  }

  const wave = findWave(plan, waveId);
  if (!wave) {
    return {
      ok: false,
      wave_id: waveId,
      reconciled: [],
      already_recorded: 0,
      not_found: [],
      error: `wave '${waveId}' not found in plan`,
    };
  }

  const waveState = state.waves?.[waveId];
  const existingMrUrls = waveState?.mr_urls ?? {};
  const platform = detectPlatform();

  const reconciled: Reconciled[] = [];
  let alreadyRecorded = 0;
  const notFound: number[] = [];

  for (const issue of wave.issues ?? []) {
    const key = String(issue.number);
    if (existingMrUrls[key]) {
      alreadyRecorded++;
      continue;
    }

    const mrUrl =
      platform === 'github'
        ? queryGithubMergedPrs(issue.number, deps)
        : queryGitlabMergedMrs(issue.number, deps);

    if (mrUrl) {
      try {
        deps.execFn(
          `wave-status record-mr ${issue.number} ${quoteArg(mrUrl)}`,
        );
      } catch {
        // Best-effort — continue even if record-mr fails
      }
      reconciled.push({ issue_number: issue.number, mr_ref: mrUrl });
    } else {
      notFound.push(issue.number);
    }
  }

  return {
    ok: true,
    wave_id: waveId,
    reconciled,
    already_recorded: alreadyRecorded,
    not_found: notFound,
  };
}

const waveReconcileMrsHandler: HandlerDef = {
  name: 'wave_reconcile_mrs',
  description:
    'Backfill mr_urls for issues in a wave by querying the platform for merged PRs/MRs matching feature/<N>-* branches. Call site: after wave_preflight, before pr_merge or wave_close_issue.',
  inputSchema,
  async execute(rawArgs: unknown) {
    try {
      const result = await reconcile(rawArgs);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error }) }],
      };
    }
  },
};

export default waveReconcileMrsHandler;
