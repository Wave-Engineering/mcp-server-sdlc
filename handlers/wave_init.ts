import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { detectPlatform } from '../lib/shared/detect-platform.js';
import { parseRepoSlug } from '../lib/shared/parse-repo-slug.js';

const inputSchema = z.object({
  plan_json: z.string().min(1, 'plan_json must be a non-empty JSON string'),
  extend: z.boolean().optional().default(false),
  project_root: z.string().optional(),
  repo: z
    .string()
    .regex(/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/, 'repo must be owner/repo format')
    .optional(),
  // KAHUNA bootstrap (devspec §5.1.3). Optional; absence preserves the
  // pre-KAHUNA behavior end-to-end (CT-03 backward compat).
  kahuna: z
    .object({
      epic_id: z.number().int().positive(),
      slug: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/, 'slug must be kebab-case (lowercase, digits, hyphens)'),
    })
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

// ---------------------------------------------------------------------------
// KAHUNA bootstrap helpers (devspec §5.1.3)
// ---------------------------------------------------------------------------

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function execOk(cmd: string, cwd: string): { ok: boolean; stdout: string; stderr: string } {
  try {
    const stdout = execSync(cmd, { encoding: 'utf8', cwd });
    return { ok: true, stdout: stdout.trim(), stderr: '' };
  } catch (err) {
    const e = err as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
    const stderr = (typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString() ?? '') ?? '';
    const stdout = (typeof e.stdout === 'string' ? e.stdout : e.stdout?.toString() ?? '') ?? '';
    return { ok: false, stdout: stdout.trim(), stderr: stderr.trim() || e.message || '' };
  }
}

function branchExistsOnRemote(cwd: string, branch: string): boolean {
  const out = execOk(`git ls-remote --heads origin ${shellEscape(branch)}`, cwd);
  return out.ok && out.stdout.length > 0;
}

const SHA_RE = /^[0-9a-f]{40}$/;

function getMainHeadSha(cwd: string, repoSlug: string | null, platform: 'github' | 'gitlab', baseBranch: string): string {
  // `gh api` and `glab api` resolve repo context from the URL path itself —
  // no `--repo` flag (that belongs to the porcelain subcommands like
  // `gh pr ...`). The slug is validated by parseRepoSlug's regex; baseBranch
  // is shell-escaped because it originates from operator-controlled plan_json.
  if (platform === 'github') {
    const slug = repoSlug ?? ':owner/:repo';
    const out = execOk(
      `gh api repos/${slug}/branches/${shellEscape(baseBranch)} --jq .commit.sha`,
      cwd,
    );
    if (!out.ok || out.stdout.length === 0) {
      throw new Error(`failed to read ${baseBranch} HEAD SHA: ${out.stderr || 'empty response'}`);
    }
    if (!SHA_RE.test(out.stdout)) {
      throw new Error(`unexpected SHA from gh api: ${out.stdout.slice(0, 80)}`);
    }
    return out.stdout;
  }
  // GitLab
  const slug = repoSlug ?? '';
  const encoded = slug.replace(/\//g, '%2F');
  const out = execOk(
    `glab api projects/${encoded}/repository/branches/${shellEscape(baseBranch)}`,
    cwd,
  );
  if (!out.ok) {
    throw new Error(`failed to read ${baseBranch} HEAD SHA: ${out.stderr || 'empty response'}`);
  }
  try {
    const parsed = JSON.parse(out.stdout) as { commit?: { id?: string } };
    const sha = parsed.commit?.id;
    if (typeof sha !== 'string' || !SHA_RE.test(sha)) {
      throw new Error(`unexpected branches API shape: invalid or missing commit.id`);
    }
    return sha;
  } catch (err) {
    throw new Error(`failed to parse ${baseBranch} branches API: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function createKahunaBranch(
  cwd: string,
  repoSlug: string | null,
  platform: 'github' | 'gitlab',
  branch: string,
  sha: string,
): void {
  if (platform === 'github') {
    const slug = repoSlug ?? ':owner/:repo';
    const out = execOk(
      `gh api repos/${slug}/git/refs -X POST -f ref=${shellEscape(`refs/heads/${branch}`)} -f sha=${shellEscape(sha)}`,
      cwd,
    );
    if (!out.ok) {
      throw new Error(`failed to create branch ${branch}: ${out.stderr || out.stdout}`);
    }
    return;
  }
  // GitLab — POST /projects/:id/repository/branches?branch=<name>&ref=<sha>
  const encoded = (repoSlug ?? '').replace(/\//g, '%2F');
  const out = execOk(
    `glab api projects/${encoded}/repository/branches -X POST -f branch=${shellEscape(branch)} -f ref=${shellEscape(sha)}`,
    cwd,
  );
  if (!out.ok) {
    throw new Error(`failed to create branch ${branch}: ${out.stderr || out.stdout}`);
  }
}

function recordKahunaBranchInState(cwd: string, branch: string): void {
  const out = execOk(`wave-status set-kahuna-branch ${shellEscape(branch)}`, cwd);
  if (!out.ok) {
    throw new Error(`wave-status set-kahuna-branch failed: ${out.stderr || out.stdout}`);
  }
}

interface KahunaBootstrapResult {
  ok: true;
  kahuna_branch: string;
  created: boolean; // true if newly created, false if reused
}

interface KahunaBootstrapError {
  ok: false;
  error: string;
}

async function bootstrapKahunaBranch(
  cwd: string,
  kahuna: { epic_id: number; slug: string },
  baseBranch: string,
  readState: () => Promise<{ kahuna_branch?: string | null }>,
): Promise<KahunaBootstrapResult | KahunaBootstrapError> {
  const desired = `kahuna/${kahuna.epic_id}-${kahuna.slug}`;
  const platform = detectPlatform();
  const repoSlug = parseRepoSlug();

  const state = await readState();
  const recorded = state.kahuna_branch ?? null;

  if (recorded === desired) {
    // State already records the desired branch — verify presence on remote.
    if (branchExistsOnRemote(cwd, desired)) {
      return { ok: true, kahuna_branch: desired, created: false };
    }
    // Recorded but missing from remote: state and platform are out of sync.
    // Refuse rather than silently recreate; this is a corruption signal that
    // warrants human attention (matches the spirit of the spec's orphan rule).
    return {
      ok: false,
      error: `kahuna_branch ${desired} is recorded in state but missing from remote — manual triage required`,
    };
  }

  if (recorded !== null && recorded !== desired) {
    // State has a different kahuna_branch — refuse rather than overwrite.
    return {
      ok: false,
      error: `wave state already records kahuna_branch '${recorded}' which does not match requested '${desired}'`,
    };
  }

  // recorded === null: state is unset. Check the remote for an orphan.
  if (branchExistsOnRemote(cwd, desired)) {
    return {
      ok: false,
      error: `orphan kahuna branch ${desired} exists on remote but is not recorded in state — manual triage required`,
    };
  }

  // Fresh creation path.
  const sha = getMainHeadSha(cwd, repoSlug, platform, baseBranch);
  createKahunaBranch(cwd, repoSlug, platform, desired, sha);
  recordKahunaBranchInState(cwd, desired);
  return { ok: true, kahuna_branch: desired, created: true };
}

const waveInitHandler: HandlerDef = {
  name: 'wave_init',
  description:
    'Initialize a wave plan from structured JSON; supports --extend mode. ' +
    'Optional `kahuna` argument bootstraps a `kahuna/<epic_id>-<slug>` integration branch ' +
    'off the plan\'s base_branch (default `main`) and records it in wave state — used by ' +
    'autonomous /wavemachine flows; pre-KAHUNA callers omit `kahuna` and see no behavior change.',
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

      // KAHUNA bootstrap (devspec §5.1.3): runs after init/extend has written
      // state.json, so we can read+update it. Failures here surface as
      // ok:false but do NOT roll back the wave init — the plan is already
      // recorded; the operator can retry the kahuna step.
      let kahunaBranch: string | undefined;
      let kahunaCreated: boolean | undefined;
      if (args.kahuna !== undefined) {
        const cwd = projectDir(args.project_root);
        const planParsedForBase = JSON.parse(args.plan_json) as PlanData & { base_branch?: string };
        const baseBranch = typeof planParsedForBase.base_branch === 'string' && planParsedForBase.base_branch.length > 0
          ? planParsedForBase.base_branch
          : 'main';
        const dir = await statusDir(cwd);
        const statePath = join(dir, 'state.json');
        const result = await bootstrapKahunaBranch(
          cwd,
          args.kahuna,
          baseBranch,
          async () => (await readJson(statePath)) as { kahuna_branch?: string | null },
        );
        if (!result.ok) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: result.error }) }],
          };
        }
        kahunaBranch = result.kahuna_branch;
        kahunaCreated = result.created;
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
              ...(kahunaBranch !== undefined ? { kahuna_branch: kahunaBranch, kahuna_created: kahunaCreated } : {}),
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
