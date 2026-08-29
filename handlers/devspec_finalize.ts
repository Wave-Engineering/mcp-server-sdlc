import { join } from 'path';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import {
  extractSection,
  parseManifestTables,
  parseMvIds,
  type ManifestRow,
  stripMdDecoration,
  hasPath,
  hasNAOptOut,
} from '../lib/devspec-parser.js';
import { runArgv } from '../lib/shared/error-norm.js';
import { PROTECTED_BRANCH_PATTERN } from '../lib/shared/protected-branch.js';

const inputSchema = z.object({
  path: z.string().min(1, 'path must be a non-empty string'),
  // #458: the Plan issue number the Dev Spec finalizes. The commit subject is
  // `docs(devspec): finalize Dev Spec for Plan #<plan_id>`. The Dev Spec doc
  // does NOT embed its own plan number, so the caller supplies it. When omitted
  // the handler stays pure validation (commits nothing) — preserving the
  // backward-compatible behavior of the pre-#458 tool.
  plan_id: z.number().int().positive().optional(),
  // Additional doc-write paths to stage alongside the Dev Spec doc (the devspec
  // ledger / memory artifacts the caller wrote). Optional; the Dev Spec doc at
  // `path` is always staged.
  files: z.array(z.string().min(1)).optional(),
});

// -----------------------------------------------------------------------------
// phases-waves.json resolution (for the depends_on check)
// -----------------------------------------------------------------------------

function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

async function fileExists(path: string): Promise<boolean> {
  return await Bun.file(path).exists();
}

/**
 * Resolve the project's phases-waves.json path. Mirrors the logic in
 * wave_next_pending: prefer `.sdlc/waves/phases-waves.json` if `.sdlc/` exists;
 * otherwise fall back to `.claude/status/phases-waves.json`.
 */
async function resolvePhasesWavesPath(root: string): Promise<string> {
  const sdlc = join(root, '.sdlc');
  if (await fileExists(sdlc)) return join(sdlc, 'waves', 'phases-waves.json');
  return join(root, '.claude', 'status', 'phases-waves.json');
}

// ManifestRow interface now imported from devspec-parser.js

interface CheckResult {
  check: string;
  pass: boolean;
  evidence: string;
}

// extractSection now imported from devspec-parser.js

// parseManifestTable replaced by parseManifestTables (imported from devspec-parser.js)

// parseMvIds now imported from devspec-parser.js

// -----------------------------------------------------------------------------
// Helpers for individual checks
// -----------------------------------------------------------------------------

// hasPath, hasNAOptOut, and stripMdDecoration now imported from devspec-parser.js

/**
 * Detect whether a Deliverable cell reads as a bare verb/action phrase with no
 * concrete noun artifact. Conservative heuristic: flag cells that START with a
 * common action verb AND contain fewer than 3 words. Only fires if the row
 * also has no file path.
 */
const ACTION_VERBS = new Set([
  'build',
  'deploy',
  'test',
  'install',
  'verify',
  'run',
  'execute',
  'create',
  'implement',
  'write',
  'add',
  'check',
  'ensure',
  'validate',
  'configure',
  'setup',
  'set',
  'update',
  'remove',
  'delete',
  'produce',
  'generate',
]);

function isVerbOnly(deliverable: string): boolean {
  const clean = stripMdDecoration(deliverable).toLowerCase();
  if (!clean) return false;
  const words = clean.split(/\s+/);
  const first = words[0]?.replace(/[^a-z]/g, '') ?? '';
  if (!ACTION_VERBS.has(first)) return false;
  // Acceptable if there is a noun-like token (ends with typical noun suffixes
  // or references a file/document word). Heuristic: if the phrase contains
  // any of these nouny words, treat it as having a noun.
  const NOUNY_WORDS = /\b(doc|docs|documentation|file|script|test|suite|handler|pipeline|manifest|report|readme|changelog|runbook|manual|guide|reference|spec|schema|config|dockerfile|makefile|readme|binary|image|package|module|library|template|diagram)\b/i;
  if (NOUNY_WORDS.test(clean)) return false;
  return words.length < 4;
}

// -----------------------------------------------------------------------------
// The 7 checks
// -----------------------------------------------------------------------------

function checkTier1Paths(rows: ManifestRow[], hasSection5A: boolean): CheckResult {
  if (!hasSection5A) {
    return {
      check: 'tier1_paths',
      pass: false,
      evidence: 'Section 5.A Deliverables Manifest not found',
    };
  }
  const tier1 = rows.filter(r => /^1\b/.test(stripMdDecoration(r.tier)));
  if (tier1.length === 0) {
    return {
      check: 'tier1_paths',
      pass: false,
      evidence: 'no Tier 1 rows found in Deliverables Manifest',
    };
  }
  const missing: string[] = [];
  for (const row of tier1) {
    if (!hasPath(row) && !hasNAOptOut(row)) {
      missing.push(row.id || row.deliverable || '(unnamed row)');
    }
  }
  if (missing.length === 0) {
    return {
      check: 'tier1_paths',
      pass: true,
      evidence: `${tier1.length}/${tier1.length} Tier 1 rows have paths or N/A`,
    };
  }
  return {
    check: 'tier1_paths',
    pass: false,
    evidence: `${tier1.length - missing.length}/${tier1.length} Tier 1 rows have paths or N/A; missing: ${missing.join(', ')}`,
  };
}

function checkTier2Triggers(rows: ManifestRow[], mvIds: string[]): CheckResult {
  // Mechanically detectable trigger: MV-XX items in 6.4 => need a
  // "Manual test procedures" (or similar) row in the manifest.
  const firedTriggers: { name: string; satisfied: boolean }[] = [];

  if (mvIds.length > 0) {
    const hasManualProcRow = rows.some(r => {
      const d = stripMdDecoration(r.deliverable).toLowerCase();
      return /manual/.test(d) && /(test|verif|procedur)/.test(d);
    });
    firedTriggers.push({
      name: 'Manual test procedures (triggered by MV items in 6.4)',
      satisfied: hasManualProcRow,
    });
  }

  if (firedTriggers.length === 0) {
    return {
      check: 'tier2_triggers',
      pass: true,
      evidence: 'no mechanically detectable Tier 2 triggers have fired',
    };
  }

  const unsatisfied = firedTriggers.filter(t => !t.satisfied);
  if (unsatisfied.length === 0) {
    return {
      check: 'tier2_triggers',
      pass: true,
      evidence: `${firedTriggers.length}/${firedTriggers.length} fired Tier 2 triggers have manifest rows`,
    };
  }
  return {
    check: 'tier2_triggers',
    pass: false,
    evidence: `missing manifest row(s) for fired trigger(s): ${unsatisfied.map(t => t.name).join('; ')}`,
  };
}

function checkWaveAssignments(rows: ManifestRow[]): CheckResult {
  const active = rows.filter(r => !hasNAOptOut(r));
  if (active.length === 0) {
    return {
      check: 'wave_assignments',
      pass: false,
      evidence: 'no active manifest rows to check',
    };
  }
  const missing: string[] = [];
  for (const row of active) {
    const produced = stripMdDecoration(row.produced_in);
    if (!produced) {
      missing.push(row.id || row.deliverable || '(unnamed row)');
    }
  }
  if (missing.length === 0) {
    return {
      check: 'wave_assignments',
      pass: true,
      evidence: `${active.length}/${active.length} active manifest rows have a Produced In wave`,
    };
  }
  return {
    check: 'wave_assignments',
    pass: false,
    evidence: `${active.length - missing.length}/${active.length} active rows have Produced In; missing: ${missing.join(', ')}`,
  };
}

function checkMvCoverage(rows: ManifestRow[], mvIds: string[]): CheckResult {
  if (mvIds.length === 0) {
    return {
      check: 'mv_coverage',
      pass: true,
      evidence: 'no MV-XX items in Section 6.4 to cover',
    };
  }
  // There must be at least one manifest row describing a manual test
  // procedures document (the per-MV procedure lives inside that doc).
  const hasManualProcRow = rows.some(r => {
    const d = stripMdDecoration(r.deliverable).toLowerCase();
    return /manual/.test(d) && /(test|verif|procedur)/.test(d);
  });
  if (hasManualProcRow) {
    return {
      check: 'mv_coverage',
      pass: true,
      evidence: `${mvIds.length} MV item(s) in Section 6.4 covered by a Manual Test Procedures manifest row`,
    };
  }
  return {
    check: 'mv_coverage',
    pass: false,
    evidence: `${mvIds.join(', ')} in Section 6.4 but no Manual Test Procedures row in manifest`,
  };
}

function checkVerbsWithoutNouns(rows: ManifestRow[]): CheckResult {
  const offenders: string[] = [];
  for (const row of rows) {
    if (hasNAOptOut(row)) continue;
    if (hasPath(row)) continue;
    if (isVerbOnly(row.deliverable)) {
      offenders.push(`${row.id || '(unnamed)'}: "${stripMdDecoration(row.deliverable)}"`);
    }
  }
  if (offenders.length === 0) {
    return {
      check: 'verbs_without_nouns',
      pass: true,
      evidence: 'no verb-only deliverables detected',
    };
  }
  return {
    check: 'verbs_without_nouns',
    pass: false,
    evidence: `${offenders.length} verb-only deliverable(s) without file path: ${offenders.join('; ')}`,
  };
}

function checkAudienceFacing(rows: ManifestRow[]): CheckResult {
  // Look for DM-09 row, or any row explicitly tagged as audience-facing /
  // ops runbook / user manual / API or CLI reference.
  const candidates = rows.filter(r => {
    const id = stripMdDecoration(r.id).toUpperCase();
    if (id === 'DM-09') return true;
    const d = stripMdDecoration(r.deliverable).toLowerCase();
    return /audience[- ]facing|runbook|user manual|api reference|cli reference/.test(d);
  });
  if (candidates.length === 0) {
    return {
      check: 'audience_facing',
      pass: false,
      evidence: 'no audience-facing doc row (DM-09 or runbook/user manual/API ref) found in manifest',
    };
  }
  const withPath = candidates.filter(r => hasPath(r));
  if (withPath.length > 0) {
    return {
      check: 'audience_facing',
      pass: true,
      evidence: `${withPath.length} audience-facing doc row(s) with file path (e.g., ${withPath[0].id || 'DM-09'})`,
    };
  }
  return {
    check: 'audience_facing',
    pass: false,
    evidence: `audience-facing doc row(s) present but none have a file path: ${candidates.map(r => r.id || '(unnamed)').join(', ')}`,
  };
}

interface PhasesWavesStory {
  number?: number;
  id?: string | number;
  title?: string;
  depends_on?: unknown;
}

interface PhasesWavesWave {
  id?: string;
  stories?: PhasesWavesStory[];
  issues?: PhasesWavesStory[];
}

interface PhasesWavesPhase {
  name?: string;
  waves?: PhasesWavesWave[];
}

interface PhasesWavesData {
  phases?: PhasesWavesPhase[];
}

/**
 * Return a human-readable ref for a story (prefer numeric `number`, then `id`,
 * then the title, then a positional fallback).
 */
function storyRef(story: PhasesWavesStory, waveId: string, index: number): string {
  if (typeof story.number === 'number') return `#${story.number}`;
  if (story.id != null && String(story.id).length > 0) return String(story.id);
  if (typeof story.title === 'string' && story.title.length > 0) return story.title;
  return `${waveId}[${index}]`;
}

/**
 * Check that every Story across every Wave in `phases-waves.json` has a
 * `depends_on` field. An empty array `[]` is valid; a missing field or `null`
 * is invalid. Required for Category B drift detection per Dev Spec §5.4.3.
 *
 * If `phases-waves.json` does not exist yet (finalize runs BEFORE
 * `/devspec upshift` writes it), the check is treated as vacuously true with
 * informative evidence — authoring hasn't reached that stage yet.
 */
async function checkDependsOn(): Promise<CheckResult> {
  let planPath: string;
  try {
    planPath = await resolvePhasesWavesPath(projectDir());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      check: 'depends_on',
      pass: false,
      evidence: `failed to resolve phases-waves.json path: ${msg}`,
    };
  }

  if (!(await fileExists(planPath))) {
    return {
      check: 'depends_on',
      pass: true,
      evidence: `phases-waves.json not yet written (${planPath}); check deferred until post-upshift`,
    };
  }

  let plan: PhasesWavesData;
  try {
    plan = (await Bun.file(planPath).json()) as PhasesWavesData;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      check: 'depends_on',
      pass: false,
      evidence: `failed to parse ${planPath}: ${msg}`,
    };
  }

  const offenders: string[] = [];
  let totalStories = 0;

  for (const phase of plan.phases ?? []) {
    for (const wave of phase.waves ?? []) {
      const waveId = wave.id ?? '(unnamed wave)';
      const stories = wave.stories ?? wave.issues ?? [];
      for (let i = 0; i < stories.length; i++) {
        const story = stories[i];
        totalStories += 1;
        // Missing field OR explicit null → invalid. Empty array is valid.
        if (!Object.prototype.hasOwnProperty.call(story, 'depends_on') || story.depends_on === null) {
          offenders.push(storyRef(story, waveId, i));
        }
      }
    }
  }

  if (totalStories === 0) {
    return {
      check: 'depends_on',
      pass: true,
      evidence: `no Stories found in ${planPath}`,
    };
  }

  if (offenders.length === 0) {
    return {
      check: 'depends_on',
      pass: true,
      evidence: `${totalStories}/${totalStories} Stories in phases-waves.json have a depends_on field`,
    };
  }

  return {
    check: 'depends_on',
    pass: false,
    evidence: `Stories missing required 'depends_on' field (may be empty array): ${offenders.join(', ')}`,
  };
}

function checkDodReferences(section7Md: string | null): CheckResult {
  if (section7Md === null) {
    return {
      check: 'dod_references',
      pass: false,
      evidence: 'Section 7 Definition of Done not found',
    };
  }
  if (/deliverables manifest/i.test(section7Md)) {
    // And it must NOT still reference the legacy split terms as the
    // source-of-truth — we accept any mention of Deliverables Manifest.
    return {
      check: 'dod_references',
      pass: true,
      evidence: 'Section 7 references the Deliverables Manifest',
    };
  }
  const legacyMentions: string[] = [];
  if (/artifact manifest/i.test(section7Md)) legacyMentions.push('Artifact Manifest');
  if (/documentation kit/i.test(section7Md)) legacyMentions.push('Documentation Kit');
  const legacyNote = legacyMentions.length > 0 ? ` (legacy terms present: ${legacyMentions.join(', ')})` : '';
  return {
    check: 'dod_references',
    pass: false,
    evidence: `Section 7 does not reference the Deliverables Manifest${legacyNote}`,
  };
}

// -----------------------------------------------------------------------------
// Commit-on-pass (#458 / cc-workflow#604)
// -----------------------------------------------------------------------------

type RefusedReason = 'protected_branch' | 'no_changes' | null;

interface CommitOutcome {
  committed: boolean;
  /** The new commit's SHA; empty when nothing was committed. */
  commit_sha: string;
  /** Repo-relative paths actually committed. */
  files: string[];
  refused_reason: RefusedReason;
}

const NOT_COMMITTED: CommitOutcome = {
  committed: false,
  commit_sha: '',
  files: [],
  refused_reason: null,
};

/** Current branch via `git branch --show-current`; '' on failure/detached HEAD. */
function currentBranch(cwd: string): string {
  const r = runArgv(['git', 'branch', '--show-current'], cwd);
  return r.exitCode === 0 ? r.stdout.trim() : '';
}

function splitLines(s: string): string[] {
  return s
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0);
}

/**
 * Stage + commit the finalize doc writes on the CURRENT branch (#458).
 *
 * Contract:
 *  - **No push** — the commit is the tool's only mutation; the caller controls push.
 *  - **Refuse on a protected branch** (`main` | `release/*`, the #470 name
 *    convention) → `refused_reason: 'protected_branch'`, no commit.
 *  - **Idempotent** — if nothing among `paths` is staged after `git add`, make no
 *    commit → `refused_reason: 'no_changes'`.
 *  - Plain `git` via the shared `runArgv` subprocess helper — no `gh`/`glab`, no
 *    platform branching (R-09/R-10 gates).
 *
 * The commit is pathspec-limited to `paths` so unrelated staged content elsewhere
 * in the index is never swept into the finalize commit.
 */
function commitFinalizeDocs(cwd: string, planId: number, paths: string[]): CommitOutcome {
  const branch = currentBranch(cwd);
  if (branch.length === 0) {
    // Detached HEAD or not a git repo — cannot verify protection; do not commit.
    return NOT_COMMITTED;
  }

  // Refuse on a protected branch — name convention only, no host query (#470).
  if (PROTECTED_BRANCH_PATTERN.test(branch)) {
    return { committed: false, commit_sha: '', files: [], refused_reason: 'protected_branch' };
  }

  // Stage the Dev Spec doc + any ledger/memory artifacts.
  const addRes = runArgv(['git', 'add', '--', ...paths], cwd);
  if (addRes.exitCode !== 0) {
    return NOT_COMMITTED;
  }

  // What is actually staged among OUR paths (repo-relative). Empty → idempotent.
  const diffRes = runArgv(['git', 'diff', '--cached', '--name-only', '--', ...paths], cwd);
  const staged = diffRes.exitCode === 0 ? splitLines(diffRes.stdout) : [];
  if (staged.length === 0) {
    return { committed: false, commit_sha: '', files: [], refused_reason: 'no_changes' };
  }

  // Commit — bare subject (no slug suffix, per #458), pathspec-limited.
  const subject = `docs(devspec): finalize Dev Spec for Plan #${planId}`;
  const commitRes = runArgv(['git', 'commit', '-m', subject, '--', ...paths], cwd);
  if (commitRes.exitCode !== 0) {
    return NOT_COMMITTED;
  }

  const shaRes = runArgv(['git', 'rev-parse', 'HEAD'], cwd);
  const commit_sha = shaRes.exitCode === 0 ? shaRes.stdout.trim() : '';
  return { committed: true, commit_sha, files: staged, refused_reason: null };
}

// -----------------------------------------------------------------------------
// Handler
// -----------------------------------------------------------------------------

async function readSpec(path: string): Promise<string> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`file not found: ${path}`);
  }
  return await file.text();
}

const devspecFinalizeHandler: HandlerDef = {
  name: 'devspec_finalize',
  description:
    'Run the 8 mechanical finalization checks from Dev Spec Section 7.2 and return pass/fail + evidence per check. ' +
    'When `plan_id` is supplied AND every check passes, stage + commit the finalize doc writes (the Dev Spec doc at ' +
    '`path` plus any `files`) on the current branch with the bare subject `docs(devspec): finalize Dev Spec for Plan #<plan_id>` ' +
    '— never pushing, refusing on a protected branch, idempotent when there is nothing to commit.',
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

    let body: string;
    try {
      body = await readSpec(args.path);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error }) }],
      };
    }

    const section5A = extractSection(body, /deliverables manifest/i);
    const section64 = extractSection(body, /manual verification procedures/i);
    const section7 = extractSection(body, /^(?:7\.?\s+)?definition of done\b/i);

    const rows = section5A ? parseManifestTables(section5A) : [];
    const mvIds = section64 ? parseMvIds(section64) : [];

    const checks: CheckResult[] = [
      checkTier1Paths(rows, section5A !== null),
      checkTier2Triggers(rows, mvIds),
      checkWaveAssignments(rows),
      checkMvCoverage(rows, mvIds),
      checkVerbsWithoutNouns(rows),
      checkAudienceFacing(rows),
      checkDodReferences(section7),
      await checkDependsOn(),
    ];

    const passed = checks.filter(c => c.pass).length;
    const total = checks.length;
    const allPass = passed === total;

    // #458: on all-checks-pass, commit the finalize doc writes on the current
    // branch. Gated on `plan_id` — without it the tool stays pure validation
    // (backward-compatible with pre-#458 callers), and commits nothing on a
    // failing check.
    let outcome: CommitOutcome = NOT_COMMITTED;
    if (allPass && args.plan_id !== undefined) {
      const stagePaths = [args.path, ...(args.files ?? [])];
      outcome = commitFinalizeDocs(projectDir(), args.plan_id, stagePaths);
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            path: args.path,
            checks,
            passed,
            total,
            ready_for_approval: allPass,
            committed: outcome.committed,
            commit_sha: outcome.commit_sha,
            files: outcome.files,
            refused_reason: outcome.refused_reason,
          }),
        },
      ],
    };
  },
};

export default devspecFinalizeHandler;
