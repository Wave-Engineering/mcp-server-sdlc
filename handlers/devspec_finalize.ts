import { z } from 'zod';
import type { HandlerDef } from '../types.js';

const inputSchema = z.object({
  path: z.string().min(1, 'path must be a non-empty string'),
});

interface ManifestRow {
  id: string;
  deliverable: string;
  category: string;
  tier: string;
  file_path: string;
  produced_in: string;
  status: string;
  notes: string;
  // Raw cells + header-aware accessor for graceful degradation on column order.
  raw: Record<string, string>;
}

interface CheckResult {
  check: string;
  pass: boolean;
  evidence: string;
}

// -----------------------------------------------------------------------------
// Section extraction
// -----------------------------------------------------------------------------

/**
 * Extract a markdown section body given a heading regex. Captures everything
 * from the matching heading up to (but not including) the next heading at the
 * same or lower level.
 */
function extractSection(markdown: string, headingRegex: RegExp): string | null {
  const lines = markdown.split('\n');
  let inSection = false;
  let sectionLevel = 0;
  const collected: string[] = [];

  for (const line of lines) {
    const headingMatch = /^(#+)\s+(.*)$/.exec(line);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const title = headingMatch[2].trim();
      if (inSection) {
        if (level <= sectionLevel) break;
      }
      if (!inSection && headingRegex.test(title)) {
        inSection = true;
        sectionLevel = level;
        continue;
      }
    }
    if (inSection) collected.push(line);
  }

  return inSection ? collected.join('\n') : null;
}

// -----------------------------------------------------------------------------
// Manifest table parsing
// -----------------------------------------------------------------------------

function parseManifestTable(sectionMd: string): ManifestRow[] {
  const rows: ManifestRow[] = [];
  const lines = sectionMd.split('\n').map(l => l.trim());

  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('|') && lines[i].includes('|', 1)) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return rows;

  const headerCells = lines[headerIdx]
    .split('|')
    .slice(1, -1)
    .map(c => c.trim().toLowerCase());

  const findCol = (needles: string[]): number => {
    for (const needle of needles) {
      const idx = headerCells.findIndex(c => c.includes(needle));
      if (idx !== -1) return idx;
    }
    return -1;
  };

  const idCol = findCol(['id']);
  const deliverableCol = findCol(['deliverable', 'description']);
  const categoryCol = findCol(['category']);
  const tierCol = findCol(['tier']);
  const pathCol = findCol(['file path', 'path', 'evidence']);
  const producedCol = findCol(['produced in', 'produced', 'wave']);
  const statusCol = findCol(['status']);
  const notesCol = findCol(['notes']);

  let startRow = headerIdx + 1;
  if (startRow < lines.length && /^\|[\s\-:|]+\|?$/.test(lines[startRow])) {
    startRow += 1;
  }

  for (let i = startRow; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('|')) break;
    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    if (cells.length === 0) continue;

    const get = (idx: number) => (idx >= 0 && idx < cells.length ? cells[idx] : '');
    const raw: Record<string, string> = {};
    for (let j = 0; j < headerCells.length; j++) {
      raw[headerCells[j]] = cells[j] ?? '';
    }

    rows.push({
      id: get(idCol),
      deliverable: get(deliverableCol),
      category: get(categoryCol),
      tier: get(tierCol),
      file_path: get(pathCol),
      produced_in: get(producedCol),
      status: get(statusCol),
      notes: get(notesCol),
      raw,
    });
  }

  return rows;
}

/**
 * Parse MV-XX IDs out of Section 6.4. Looks at markdown table rows with an
 * ID cell matching /^MV-\d+/i and returns the IDs in document order.
 */
function parseMvIds(section64Md: string): string[] {
  const ids: string[] = [];
  const lines = section64Md.split('\n').map(l => l.trim());
  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    for (const cell of cells) {
      const m = /^(MV-\d+)/i.exec(cell);
      if (m) {
        ids.push(m[1].toUpperCase());
        break;
      }
    }
  }
  return ids;
}

// -----------------------------------------------------------------------------
// Helpers for individual checks
// -----------------------------------------------------------------------------

/**
 * True if a manifest row's File Path field is empty (i.e., no file assigned
 * and no "N/A — because" opt-out).
 */
function hasPath(row: ManifestRow): boolean {
  const p = stripMdDecoration(row.file_path);
  return p.length > 0 && !/^n\/a\b/i.test(p);
}

function hasNAOptOut(row: ManifestRow): boolean {
  const p = stripMdDecoration(row.file_path);
  return /^n\/a\s*[—\-:]/i.test(p) && /because/i.test(p);
}

/**
 * Remove backticks, italics, and placeholder decorations from a markdown cell.
 */
function stripMdDecoration(s: string): string {
  return s.replace(/`/g, '').replace(/^_+|_+$/g, '').trim();
}

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
    'Run the 7 mechanical finalization checks from Dev Spec Section 7.2 and return pass/fail + evidence per check',
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

    const rows = section5A ? parseManifestTable(section5A) : [];
    const mvIds = section64 ? parseMvIds(section64) : [];

    const checks: CheckResult[] = [
      checkTier1Paths(rows, section5A !== null),
      checkTier2Triggers(rows, mvIds),
      checkWaveAssignments(rows),
      checkMvCoverage(rows, mvIds),
      checkVerbsWithoutNouns(rows),
      checkAudienceFacing(rows),
      checkDodReferences(section7),
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
