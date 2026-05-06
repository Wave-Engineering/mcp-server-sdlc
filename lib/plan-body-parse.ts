/**
 * Plan body parser — extracts Definition of Done and Phase info from Plan
 * tracking-issue markdown.
 *
 * A Plan issue body has:
 * - `## Plan-level Definition of Done` with a checklist
 * - `## Phases` with `### Phase N — <Name>` sub-headings, each containing
 *   a `**DoD:**` sub-list
 * - `## References` with paths (notably `Dev Spec: <path>`)
 *
 * Lives in `lib/` so the handler registry codegen (which scans
 * `handlers/*.ts`) ignores it.
 */

export interface ChecklistItem {
  checked: boolean;
  text: string;
  ref?: string;
}

export interface PhaseDoD {
  phase_name: string;
  items: ChecklistItem[];
}

export interface ParsedPlanBody {
  plan_level_dod: ChecklistItem[];
  phases: PhaseDoD[];
  devspec_path?: string;
  references: string[];
}

/**
 * Parse a Plan issue body and extract:
 * - Plan-level DoD checkboxes
 * - Per-phase DoD checklists
 * - Dev Spec path from References
 * - All reference lines
 */
export function parsePlanBody(body: string): ParsedPlanBody {
  const result: ParsedPlanBody = {
    plan_level_dod: [],
    phases: [],
    references: [],
  };

  // Split into H2 sections
  const sections = splitIntoH2Sections(body);

  // Extract Plan-level DoD
  const dodSection = sections['plan-level definition of done'] || sections['plan-level dod'];
  if (dodSection) {
    result.plan_level_dod = extractChecklistItems(dodSection);
  }

  // Extract Phases
  const phasesSection = sections['phases'];
  if (phasesSection) {
    result.phases = extractPhases(phasesSection);
  }

  // Extract References
  const referencesSection = sections['references'];
  if (referencesSection) {
    result.references = referencesSection
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);

    // Look for Dev Spec line
    const devSpecLine = result.references.find(line =>
      line.toLowerCase().startsWith('dev spec:')
    );
    if (devSpecLine) {
      // Extract path after "Dev Spec:" (may be in backticks or plain text)
      const match = devSpecLine.match(/dev spec:\s*`?([^`\n]+)`?/i);
      if (match) {
        result.devspec_path = match[1].trim();
      }
    }
  }

  return result;
}

/**
 * Split markdown body into H2 sections.
 * Returns a map of normalized heading → content.
 */
function splitIntoH2Sections(body: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const lines = body.split('\n');
  let currentHeading: string | null = null;
  let currentLines: string[] = [];

  const flush = () => {
    if (currentHeading !== null) {
      sections[currentHeading] = currentLines.join('\n').trim();
    }
  };

  for (const line of lines) {
    const h2Match = line.match(/^##\s+(.+)$/);
    if (h2Match) {
      flush();
      currentHeading = h2Match[1].trim().toLowerCase();
      currentLines = [];
    } else if (currentHeading !== null) {
      currentLines.push(line);
    }
  }
  flush();

  return sections;
}

/**
 * Extract checklist items from a section.
 * Recognizes:
 * - `- [ ] Item text`
 * - `- [x] Item text`
 * - `- [X] Item text`
 * - Optional [R-XX] ref suffix
 */
function extractChecklistItems(text: string): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  const lines = text.split('\n');

  for (const line of lines) {
    const match = line.match(/^[\s-]*\[([xX\s])\]\s*(.+)$/);
    if (match) {
      const checked = match[1].toLowerCase() === 'x';
      let itemText = match[2].trim();
      let ref: string | undefined;

      // Extract [R-XX] ref suffix
      const refMatch = itemText.match(/\[R-(\d+)\]\s*$/);
      if (refMatch) {
        ref = `R-${refMatch[1]}`;
        itemText = itemText.replace(/\s*\[R-\d+\]\s*$/, '').trim();
      }

      items.push({ checked, text: itemText, ref });
    }
  }

  return items;
}

/**
 * Extract Phase blocks from the Phases section.
 * Each phase is a `### Phase N — <Name>` heading followed by content
 * that includes a `**DoD:**` sub-list.
 */
function extractPhases(phasesSection: string): PhaseDoD[] {
  const phases: PhaseDoD[] = [];
  const lines = phasesSection.split('\n');
  let currentPhaseName: string | null = null;
  let currentPhaseLines: string[] = [];

  const flushPhase = () => {
    if (currentPhaseName !== null) {
      const dodItems = extractDoDFromPhase(currentPhaseLines.join('\n'));
      phases.push({
        phase_name: currentPhaseName,
        items: dodItems,
      });
    }
  };

  for (const line of lines) {
    const h3Match = line.match(/^###\s+Phase\s+\d+\s+[—–-]\s+(.+)$/i);
    if (h3Match) {
      flushPhase();
      currentPhaseName = h3Match[1].trim();
      currentPhaseLines = [];
    } else if (currentPhaseName !== null) {
      currentPhaseLines.push(line);
    }
  }
  flushPhase();

  return phases;
}

/**
 * Extract DoD checklist from a Phase's content.
 * Looks for `**DoD:**` followed by checklist items.
 */
function extractDoDFromPhase(phaseContent: string): ChecklistItem[] {
  const lines = phaseContent.split('\n');
  let inDoD = false;
  const dodLines: string[] = [];

  for (const line of lines) {
    if (line.match(/^\*\*DoD:\*\*/i)) {
      inDoD = true;
      continue;
    }

    if (inDoD) {
      // Stop at next bold heading or empty line after content
      if (line.match(/^\*\*.+\*\*/) || (line.trim() === '' && dodLines.length > 0 && dodLines[dodLines.length - 1].trim() === '')) {
        break;
      }
      dodLines.push(line);
    }
  }

  return extractChecklistItems(dodLines.join('\n'));
}

/**
 * Validate that a Plan body has required headings.
 * Returns an array of missing heading names, or empty array if all present.
 */
export function validatePlanBodyStructure(body: string): string[] {
  const sections = splitIntoH2Sections(body);
  const required = ['plan-level definition of done', 'phases', 'references'];
  const missing: string[] = [];

  for (const heading of required) {
    // Check for exact match or common variants
    const variants = [heading, heading.replace('definition of done', 'dod')];
    const found = variants.some(v => sections[v] !== undefined);
    if (!found) {
      missing.push(heading);
    }
  }

  return missing;
}
