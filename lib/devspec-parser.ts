/**
 * Shared Dev Spec markdown parser library.
 *
 * Extracts sections, tables, and metadata from Development Specification
 * documents following the Wave Engineering template.
 */

// -----------------------------------------------------------------------------
// Section extraction
// -----------------------------------------------------------------------------

/**
 * Extract a markdown section body given a heading regex. Captures everything
 * from the matching heading up to (but not including) the next heading at the
 * same or lower level.
 */
export function extractSection(markdown: string, headingRegex: RegExp): string | null {
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
// Manifest table parsing (Section 5.A)
// -----------------------------------------------------------------------------

export interface ManifestRow {
  id: string;
  deliverable: string;
  category: string;
  tier: string;
  file_path: string;
  produced_in: string;
  status: string;
  notes: string;
  raw: Record<string, string>;
}

/**
 * Parse ALL markdown tables in a section body (not just the first one).
 * This fixes Bug 1 — Tier 2 deliverables that appear in a second table
 * under a `#### Tier 2` sub-heading are now captured.
 *
 * Each table is recognized by a header row starting with `|` that contains
 * at least one of the expected column names (id, deliverable, tier, etc.).
 * The table continues until a non-`|` line is encountered. Multiple tables
 * can appear in the same section.
 */
export function parseManifestTables(sectionMd: string): ManifestRow[] {
  const allRows: ManifestRow[] = [];
  const lines = sectionMd.split('\n').map(l => l.trim());

  let i = 0;
  while (i < lines.length) {
    // Look for a table header — a line starting with `|` that contains
    // recognizable column names.
    if (lines[i].startsWith('|') && lines[i].includes('|', 1)) {
      const potentialHeader = lines[i];
      const cells = potentialHeader.split('|').slice(1, -1).map(c => c.trim().toLowerCase());
      // Check if this looks like a Deliverables Manifest header.
      const hasManifestColumns =
        cells.some(c => c.includes('id')) ||
        cells.some(c => c.includes('deliverable')) ||
        cells.some(c => c.includes('tier'));

      if (hasManifestColumns) {
        // Parse this table.
        const tableRows = parseOneTable(lines, i);
        allRows.push(...tableRows);
        // Skip past the rows we just parsed.
        i += tableRows.length + 2; // header + separator + N rows
        // Find the end of this table.
        while (i < lines.length && lines[i].startsWith('|')) {
          i += 1;
        }
      } else {
        i += 1;
      }
    } else {
      i += 1;
    }
  }

  return allRows;
}

/**
 * Parse a single table starting at `headerIdx`. Returns the data rows.
 */
function parseOneTable(lines: string[], headerIdx: number): ManifestRow[] {
  const rows: ManifestRow[] = [];
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

// -----------------------------------------------------------------------------
// MV-XX ID parsing (Section 6.4)
// -----------------------------------------------------------------------------

/**
 * Parse MV-XX IDs out of Section 6.4. Looks at markdown table rows with an
 * ID cell matching /^MV-\d+/i (with or without bold markdown wrapper **...**).
 * Returns the IDs in document order.
 *
 * This fixes Bug 2 — bold-wrapped MV IDs like **MV-01** are now recognized.
 */
export function parseMvIds(section64Md: string): string[] {
  const ids: string[] = [];
  const lines = section64Md.split('\n').map(l => l.trim());
  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    for (const cell of cells) {
      // Match MV-XX with optional bold wrapper.
      const m = /^\s*\*\*?\s*(MV-\d+)\s*\*\*?\s*$/i.exec(cell);
      if (m) {
        ids.push(m[1].toUpperCase());
        break;
      }
      // Also match plain MV-XX without bold (existing behavior).
      const plainMatch = /^(MV-\d+)/i.exec(cell);
      if (plainMatch) {
        ids.push(plainMatch[1].toUpperCase());
        break;
      }
    }
  }
  return ids;
}

// -----------------------------------------------------------------------------
// Metadata parsing (Section 8 story metadata)
// -----------------------------------------------------------------------------

/**
 * Parse a bolded metadata line and return JUST the wave token, stripping any
 * dependency annotations. Recognizes both metadata-line forms:
 *   - `·`-separated: "**Wave:** P1W1 · **Dependencies:** 1.1, 0.1"
 *   - legacy `|`-delimited: "**Wave:** 2 | 1.1, 1.2"
 *
 * This fixes Bug 3 / #463 — stories are grouped by the wave token alone
 * (`PxWy` or a plain number), never by the full "wave · dependencies" string,
 * which previously split one nominal wave into many groups.
 */
export function parseWaveNumber(line: string): string | null {
  const m = /^\*\*Wave:\*\*\s*(.*)$/.exec(line.trim());
  if (!m) return null;
  let full = m[1].trim();
  // Strip a `·`-separated trailing clause (e.g. "· **Dependencies:** …").
  const dotIdx = full.indexOf('·');
  if (dotIdx !== -1) {
    full = full.slice(0, dotIdx).trim();
  }
  // Strip a legacy `|`-delimited dependency suffix.
  const pipeIdx = full.indexOf('|');
  if (pipeIdx !== -1) {
    full = full.slice(0, pipeIdx).trim();
  }
  return full;
}

/**
 * Extract a comma-separated list of story IDs from a "**Dependencies:**"
 * clause. The clause may be on its own line OR embedded inline after a
 * `·`-separated "**Wave:** PxWy ·" prefix — so the label is matched anywhere
 * on the line, not only at line-start. "None" (any case) → [].
 *
 * This fixes Bug 3 / #463 — the inline dependency topology (used by
 * /prepwaves for wave ordering) is no longer silently dropped.
 */
export function parseDependencies(line: string): string[] | null {
  const m = /\*\*Dependencies:\*\*\s*(.*)$/i.exec(line.trim());
  if (!m) return null;
  let value = m[1].trim();
  // Cut off any further `·`-separated clause that trails the dependencies.
  const dotIdx = value.indexOf('·');
  if (dotIdx !== -1) {
    value = value.slice(0, dotIdx).trim();
  }
  if (/^none$/i.test(value)) return [];
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Parse any bolded metadata line like "**Label:** value".
 */
export function parseMetadata(line: string, key: string): string | null {
  const re = new RegExp(`^\\*\\*${key}:\\*\\*\\s*(.*)$`, 'i');
  const m = re.exec(line.trim());
  return m ? m[1].trim() : null;
}

// -----------------------------------------------------------------------------
// Utility functions
// -----------------------------------------------------------------------------

/**
 * Remove backticks, italics, and placeholder decorations from a markdown cell.
 */
export function stripMdDecoration(s: string): string {
  return s.replace(/`/g, '').replace(/^_+|_+$/g, '').trim();
}

/**
 * True if a manifest row's File Path field is empty (i.e., no file assigned
 * and no "N/A — because" opt-out).
 */
export function hasPath(row: ManifestRow): boolean {
  const p = stripMdDecoration(row.file_path);
  return p.length > 0 && !/^n\/a\b/i.test(p);
}

/**
 * True if a manifest row has an "N/A — because" rationale anywhere in the row
 * (File Path column OR Notes column). This matches the Dev Spec template
 * convention where rationales can appear in either location.
 */
export function hasNAOptOut(row: ManifestRow): boolean {
  // Check all cells in the row for the N/A opt-out pattern.
  const rowText = [
    row.id,
    row.deliverable,
    row.category,
    row.tier,
    row.file_path,
    row.produced_in,
    row.status,
    row.notes,
  ].join(' | ');

  return /N\/A\s+[—–-]\s+because/i.test(rowText);
}
