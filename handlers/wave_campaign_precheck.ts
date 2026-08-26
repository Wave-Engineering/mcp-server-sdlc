// wave_campaign_precheck — detect + classify leftover wave-campaign residue at
// the START of a new campaign, so /prepwaves (step 0) can surface it up front
// instead of an agent discovering it mid-flow and stalling. See #457.
//
// CONTRACT: the tool is PURE READ. It NEVER deletes a plan state file, never
// touches a kahuna branch, never runs wave_init. It detects (plan state + git),
// classifies (clean | dead | ambiguous), and returns the recovery option set;
// the skill surfaces it and the human decides. All git probes are read-only
// (`git branch --list`, `git ls-remote`, `git merge-base --is-ancestor`) and
// live in lib/shared/git-remote.ts — no gh/glab, no platform branching.

import { join } from 'path';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import {
  listLocalBranches,
  listRemoteBranches,
  isAncestor,
  type RemoteBranch,
} from '../lib/shared/git-remote.js';

const inputSchema = z
  .object({
    // Target repo dir; the operating model is session=target, so the tool reads
    // THIS repo's .claude/status + git, not necessarily the session project.
    root: z.string().optional(),
    // Protected branch to test kahuna merge-status against. Defaults to the
    // .claude-project.md "Default branch", else "main".
    protected_branch: z.string().optional(),
  })
  .strict();

const KAHUNA_GLOB = 'kahuna/*';

// Wave statuses that mean "landed / no longer pending". The Python wave_status
// CLI owns these strings; we read them forgivingly (any non-promoted status —
// including absent — counts as pending, the conservative bias).
const PROMOTED_STATUSES = new Set(['completed', 'complete', 'promoted', 'merged', 'done']);

function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

function envelope(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

async function fileExists(path: string): Promise<boolean> {
  return await Bun.file(path).exists();
}

/** Read+parse a JSON file; return null if absent or unparseable (never throws). */
async function readJsonSafe(path: string): Promise<Record<string, unknown> | null> {
  try {
    if (!(await fileExists(path))) return null;
    return (await Bun.file(path).json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function statusDir(root: string): Promise<string> {
  // Prefer .sdlc/waves/ if .sdlc/ exists; otherwise fall back to .claude/status/.
  const sdlc = join(root, '.sdlc');
  if (await fileExists(sdlc)) return join(sdlc, 'waves');
  return join(root, '.claude', 'status');
}

/** plan_id is encoded in the branch name as `kahuna/<plan_id>-<slug>`. */
function planIdFromKahuna(branch: string): number | null {
  const m = /^kahuna\/(\d+)-/.exec(branch);
  return m ? Number(m[1]) : null;
}

/** Read a numeric top-level field from a parsed JSON object, else null. */
function numericField(obj: Record<string, unknown> | null, key: string): number | null {
  const v = obj?.[key];
  return typeof v === 'number' ? v : null;
}

async function resolveProtectedBranch(root: string, override?: string): Promise<string> {
  if (override) return override;
  try {
    const text = await Bun.file(join(root, '.claude-project.md')).text();
    const m = /Default branch:\*\*\s*`?([^\s`]+)`?/i.exec(text);
    if (m) return m[1];
  } catch {
    /* no project config — fall through to the conventional default */
  }
  return 'main';
}

interface KahunaBranchStatus {
  name: string;
  local: boolean;
  remote: boolean;
  merged_into_protected: boolean;
}

/**
 * Gather every kahuna branch known to git (local + remote) plus any kahuna
 * branch referenced by state that git no longer carries, and compute per-branch
 * local/remote presence and merge-status against the protected branch.
 */
function gatherKahunaBranches(
  root: string,
  protectedBranch: string,
  stateKahuna: string | null,
): KahunaBranchStatus[] {
  const locals = new Set(listLocalBranches(root, KAHUNA_GLOB));
  const remotes: RemoteBranch[] = listRemoteBranches(root, KAHUNA_GLOB);
  const remoteSha = new Map(remotes.map(r => [r.name, r.sha]));

  const names = new Set<string>([...locals, ...remoteSha.keys()]);
  // A kahuna branch referenced by state but absent from git is still residue.
  if (stateKahuna) names.add(stateKahuna);

  return [...names].sort().map(name => {
    const local = locals.has(name);
    const remote = remoteSha.has(name);
    // Prefer the local branch name for the ancestry check; for a remote-only
    // branch use the SHA from ls-remote. A name with neither (state-only ghost)
    // falls back to the name, which will simply fail the check → not-merged.
    const ref = local ? name : remote ? (remoteSha.get(name) ?? name) : name;
    const merged_into_protected = isAncestor(root, ref, protectedBranch);
    return { name, local, remote, merged_into_protected };
  });
}

const waveCampaignPrecheckHandler: HandlerDef = {
  name: 'wave_campaign_precheck',
  description:
    'Detect + classify leftover wave-campaign residue (prior plan state + kahuna branch) at ' +
    'campaign start, so /prepwaves can surface it before fanning out. Pure read — never deletes, ' +
    'never runs wave_init. Returns state:clean|residue_found, classification:dead|ambiguous, the ' +
    'residue detail, and the recovery option set (preserve_wait|preserve_extend|replace).',
  inputSchema,
  async execute(rawArgs: unknown) {
    let args: z.infer<typeof inputSchema>;
    try {
      args = inputSchema.parse(rawArgs);
    } catch (err) {
      return envelope({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }

    try {
      const root = args.root ?? projectDir();
      const protectedBranch = await resolveProtectedBranch(root, args.protected_branch);

      const dir = await statusDir(root);
      const state = await readJsonSafe(join(dir, 'state.json'));
      const plan = await readJsonSafe(join(dir, 'phases-waves.json'));
      const planPresent = state !== null || plan !== null;

      const stateKahuna =
        typeof state?.kahuna_branch === 'string' ? (state.kahuna_branch as string) : null;
      const kahunaBranches = gatherKahunaBranches(root, protectedBranch, stateKahuna);

      // clean — no plan state AND no kahuna branch. No decision needed.
      if (!planPresent && kahunaBranches.length === 0) {
        return envelope({ ok: true, state: 'clean' });
      }

      // Wave list: from the plan's phases when present, else the state's wave map.
      const stateWaves = (state?.waves ?? {}) as Record<string, { status?: string }>;
      const waveIds: string[] = [];
      if (plan && Array.isArray(plan.phases)) {
        for (const phase of plan.phases as Array<{ waves?: Array<{ id?: string }> }>) {
          for (const w of phase.waves ?? []) {
            if (typeof w.id === 'string') waveIds.push(w.id);
          }
        }
      } else {
        waveIds.push(...Object.keys(stateWaves));
      }

      const pending_waves: string[] = [];
      const promoted_waves: string[] = [];
      for (const id of waveIds) {
        const status = stateWaves[id]?.status ?? 'pending';
        if (PROMOTED_STATUSES.has(status)) promoted_waves.push(id);
        else pending_waves.push(id);
      }

      const wavemachine_active = state?.wavemachine_active === true;

      // plan_id resolution, in priority order:
      //   1. the plan/state file's explicit `plan_id` (authoritative — present
      //      even for a persisted-but-unstarted plan with no kahuna branch yet),
      //   2. parsed from a kahuna branch name (`kahuna/<plan_id>-<slug>`). This
      //      already covers the state's own kahuna_branch: gatherKahunaBranches
      //      folds it into kahunaBranches, so the loop below parses it too.
      // null only when none of those carry it.
      let plan_id: number | null = numericField(plan, 'plan_id') ?? numericField(state, 'plan_id');
      if (plan_id === null) {
        for (const b of kahunaBranches) {
          plan_id = planIdFromKahuna(b.name);
          if (plan_id !== null) break;
        }
      }

      // ambiguous — needs a human decision — if ANY of:
      //   • a wave is still pending,
      //   • a kahuna branch has commits not yet in protected,
      //   • wavemachine is flagged active.
      // Otherwise dead — everything landed; safe to wipe (the skill still confirms).
      const ambiguous =
        pending_waves.length > 0 ||
        kahunaBranches.some(b => !b.merged_into_protected) ||
        wavemachine_active;

      return envelope({
        ok: true,
        state: 'residue_found',
        classification: ambiguous ? 'ambiguous' : 'dead',
        residue: {
          plan_id,
          wavemachine_active,
          pending_waves,
          promoted_waves,
          kahuna_branches: kahunaBranches,
        },
        options: ['preserve_wait', 'preserve_extend', 'replace'],
        recommended: 'replace',
      });
    } catch (err) {
      return envelope({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  },
};

export default waveCampaignPrecheckHandler;
