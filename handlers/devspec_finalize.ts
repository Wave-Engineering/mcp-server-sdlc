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

const inputSchema = z.object({
  path: z.string().min(1, 'path must be a non-empty string'),
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
    'Run the 8 mechanical finalization checks from Dev Spec Section 7.2 and return pass/fail + evidence per check',
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
            ready_for_approval: passed === total,
          }),
        },
      ],
    };
  },
};

export default devspecFinalizeHandler;
