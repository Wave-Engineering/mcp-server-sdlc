/**
 * Markdown Deliverables Manifest parser — promoted from `dod_load_manifest`
 * (Story 2.7, #301) so the handler can stay platform-agnostic and under the
 * ≤80-line R-05 budget. Shape parsing is pure string work; no I/O lives here.
 *
 * A PRD body contains a `## Deliverables Manifest` H2 section whose content is
 * a GitHub-flavored markdown table with flexible column ordering (id,
 * description, evidence path, status, category). This module extracts that
 * section and parses the table into typed rows.
 */

export interface Deliverable {
  id: string;
  description: string;
  evidence_path: string;
  status: string;
  category: string;
}

/**
 * Extract the "Deliverables Manifest" section from a PRD markdown body.
 *
 * Looks for a heading matching `/^##+\s*deliverables manifest/i`, then
 * captures everything until the next same-or-lower level heading.
 */
export function extractManifestSection(markdown: string): string | null {
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
      if (/^deliverables manifest/i.test(title)) {
        inSection = true;
        sectionLevel = level;
        continue;
      }
    }
    if (inSection) collected.push(line);
  }

  return inSection ? collected.join('\n').trim() : null;
}

/**
 * Parse a GitHub-flavored markdown table of deliverables into structured rows.
 * Expected columns (flexible order, case-insensitive): id, description,
 * evidence path, status, category.
 */
export function parseManifestTable(
  sectionMd: string,
): { deliverables: Deliverable[]; warnings: string[] } {
  const warnings: string[] = [];
  const deliverables: Deliverable[] = [];
  const lines = sectionMd.split('\n').map(l => l.trim());

  // Find the first table header row (starts with |).
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('|') && lines[i].includes('|', 1)) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) {
    warnings.push('no markdown table found in Deliverables Manifest section');
    return { deliverables, warnings };
  }

  const headerCells = lines[headerIdx]
    .split('|')
    .slice(1, -1)
    .map(c => c.trim().toLowerCase());

  const colIdx = (name: string): number => headerCells.findIndex(c => c.includes(name));

  const idCol = colIdx('id');
  const descCol = colIdx('description');
  const pathCol = Math.max(colIdx('evidence'), colIdx('path'));
  const statusCol = colIdx('status');
  const catCol = colIdx('category');

  // Skip separator line (|---|---|).
  let startRow = headerIdx + 1;
  if (startRow < lines.length && /^\|[\s\-:|]+\|$/.test(lines[startRow])) {
    startRow += 1;
  }

  for (let i = startRow; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('|')) break;
    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    if (cells.length < headerCells.length) {
      warnings.push(`row ${i - startRow + 1} has fewer cells than header, skipping`);
      continue;
    }
    const get = (idx: number) => (idx >= 0 && idx < cells.length ? cells[idx] : '');
    deliverables.push({
      id: get(idCol),
      description: get(descCol),
      evidence_path: get(pathCol),
      status: get(statusCol),
      category: get(catCol),
    });
  }

  return { deliverables, warnings };
}
