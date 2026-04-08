import { z } from 'zod';
import type { HandlerDef } from '../types.js';

const inputSchema = z.object({
  path: z.string().min(1, 'path must be a non-empty string'),
});

interface SectionRange {
  /** 1-indexed line number of the heading itself */
  headingLine: number;
  /** 0-indexed start of body lines (inclusive) */
  start: number;
  /** 0-indexed end of body lines (exclusive) */
  end: number;
}

/**
 * Read a Dev Spec markdown file from disk.
 *
 * Per `lesson_mcp_gotchas.md` and `dod_load_manifest.ts` precedent, this
 * handler uses `Bun.file()` for local file reads (not `fs`, not shell-out).
 */
async function readSpecFile(path: string): Promise<string> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`file not found: ${path}`);
  }
  return await file.text();
}

/**
 * Count top-level numbered sections — `## N.` headings where N is 1-9.
 *
 * Matches the Dev Spec template (Sections 1-9). A line such as
 * `## 5. Detailed Design` counts; `### 5.1 Sub-section` does not.
 */
function countTopLevelSections(lines: string[]): number {
  let count = 0;
  for (const line of lines) {
    if (/^##\s+\d+\.\s+\S/.test(line)) {
      count += 1;
    }
  }
  return count;
}

/**
 * Find a numbered top-level section (`## N. ...`) and return the line range
 * of its body — from the line after the heading up to (but not including)
 * the next `## ` heading at the same level (or EOF).
 *
 * Returns null if the section heading is not present.
 */
function findTopLevelSection(lines: string[], n: number): SectionRange | null {
  const headingRe = new RegExp(`^##\\s+${n}\\.\\s+\\S`);
  let headingIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headingRe.test(lines[i])) {
      headingIdx = i;
      break;
    }
  }
  if (headingIdx === -1) return null;

  let endIdx = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    // Stop at the next top-level `## ` heading (regardless of number).
    if (/^##\s+\S/.test(lines[i]) && !/^###/.test(lines[i])) {
      endIdx = i;
      break;
    }
  }

  return { headingLine: headingIdx + 1, start: headingIdx + 1, end: endIdx };
}

/**
 * Within Section 5, find the `### 5.A Deliverables Manifest` sub-section
 * and return its body line range.
 */
function findDeliverablesManifest(lines: string[]): SectionRange | null {
  const section5 = findTopLevelSection(lines, 5);
  if (!section5) return null;

  let headingIdx = -1;
  for (let i = section5.start; i < section5.end; i++) {
    // Match `### 5.A` or `### 5.A Deliverables Manifest`. Be lenient on title.
    if (/^###\s+5\.A(\s|$)/.test(lines[i])) {
      headingIdx = i;
      break;
    }
  }
  if (headingIdx === -1) return null;

  let endIdx = section5.end;
  for (let i = headingIdx + 1; i < section5.end; i++) {
    // Stop at the next `### ` heading inside Section 5 (e.g., `### 5.B`).
    if (/^###\s+\S/.test(lines[i])) {
      endIdx = i;
      break;
    }
  }

  return { headingLine: headingIdx + 1, start: headingIdx + 1, end: endIdx };
}

/**
 * Count rows in the Section 5.A deliverables table, splitting them into
 * "active" (a real file path) and "N/A — because" rationale rows.
 *
 * The deliverables table header looks like:
 *   `| ID | Deliverable | Category | Tier | File Path | Produced In | Status | Notes |`
 *
 * Active rule: File Path cell is non-empty and does NOT start with `N/A`.
 * N/A rule: any cell in the row contains the literal phrase `N/A — because`
 * (em dash) — this catches both File Path-column rationales and Notes-column
 * rationales.
 */
function countDeliverables(lines: string[]): { active: number; na: number } {
  const range = findDeliverablesManifest(lines);
  if (!range) return { active: 0, na: 0 };

  const sectionLines = lines.slice(range.start, range.end);

  // Find the first markdown table header (a row starting with `|`).
  let headerIdx = -1;
  for (let i = 0; i < sectionLines.length; i++) {
    const trimmed = sectionLines[i].trim();
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return { active: 0, na: 0 };

  const headerCells = sectionLines[headerIdx]
    .trim()
    .split('|')
    .slice(1, -1)
    .map(c => c.trim().toLowerCase());

  const filePathCol = headerCells.findIndex(c => c.includes('file path') || c === 'path');

  // Skip the separator row `|---|---|`.
  let startRow = headerIdx + 1;
  if (
    startRow < sectionLines.length &&
    /^\|[\s\-:|]+\|$/.test(sectionLines[startRow].trim())
  ) {
    startRow += 1;
  }

  let active = 0;
  let na = 0;

  for (let i = startRow; i < sectionLines.length; i++) {
    const line = sectionLines[i];
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) {
      // Table ended.
      break;
    }
    const cells = trimmed.split('|').slice(1, -1).map(c => c.trim());
    if (cells.length === 0) continue;

    // Skip rows that look like template placeholders (all cells are empty
    // or wrapped in [[ ]]). A real row has SOME non-placeholder content.
    const meaningful = cells.some(c => c.length > 0 && !/^\[\[.*\]\]$/.test(c));
    if (!meaningful) continue;

    // N/A — because: matches anywhere in the row (em dash, ASCII dash, or
    // hyphen). Per the Dev Spec template, the canonical form is em dash.
    const rowText = cells.join(' | ');
    const isNA = /N\/A\s+[—–-]\s+because/i.test(rowText);

    if (isNA) {
      na += 1;
      continue;
    }

    // Active: File Path cell is present, non-empty, and not starting with N/A.
    let filePath = '';
    if (filePathCol >= 0 && filePathCol < cells.length) {
      // Strip surrounding backticks/whitespace from the cell.
      filePath = cells[filePathCol].replace(/`/g, '').trim();
    }
    if (filePath.length > 0 && !/^N\/A\b/i.test(filePath)) {
      active += 1;
    }
  }

  return { active, na };
}

/**
 * Count stories and waves inside Section 8.
 *
 * - Stories: any line matching `#### Story` OR `Story N.N:` (case-sensitive
 *   on `Story` to avoid matching prose).
 * - Waves: any line matching `### Wave` OR a `Wave N` reference (where N is
 *   a positive integer immediately following the word `Wave`).
 *
 * Both counts are de-duplicated where it makes sense:
 * - Stories: counted by unique `N.N` identifier when present, otherwise by
 *   matching heading line.
 * - Waves: counted by unique wave number.
 */
function countStoriesAndWaves(lines: string[]): { stories: number; waves: number } {
  const section8 = findTopLevelSection(lines, 8);
  if (!section8) return { stories: 0, waves: 0 };

  const storyIds = new Set<string>();
  let unnumberedStories = 0;
  const waveNumbers = new Set<number>();

  // Combined story regex: #### Story [N.N[:]] OR `Story N.N:` inline.
  // Capture the N.N if present.
  const storyHeadingRe = /^####\s+Story(?:\s+(\d+(?:\.\d+)*))?[\s:]/;
  const storyInlineRe = /\bStory\s+(\d+\.\d+)\s*:/g;

  // Wave regexes — heading (### Wave N) or inline (Wave N / Wave: N /
  // **Wave:** N) reference. The metadata-field form `**Wave:** N` is the
  // canonical Dev Spec template usage; the bare `Wave N` form appears in
  // wave maps and prose.
  const waveHeadingRe = /^###\s+Wave\s+(\d+)\b/;
  const waveInlineRe = /\bWave\b[\s:*]+(\d+)\b/g;

  for (let i = section8.start; i < section8.end; i++) {
    const line = lines[i];

    // Story heading.
    const storyHeadingMatch = storyHeadingRe.exec(line);
    if (storyHeadingMatch) {
      if (storyHeadingMatch[1]) {
        storyIds.add(storyHeadingMatch[1]);
      } else {
        unnumberedStories += 1;
      }
    }

    // Inline `Story N.N:` references.
    let m: RegExpExecArray | null;
    storyInlineRe.lastIndex = 0;
    while ((m = storyInlineRe.exec(line)) !== null) {
      storyIds.add(m[1]);
    }

    // Wave heading.
    const waveHeadingMatch = waveHeadingRe.exec(line);
    if (waveHeadingMatch) {
      waveNumbers.add(parseInt(waveHeadingMatch[1], 10));
    }

    // Inline `Wave N` references.
    waveInlineRe.lastIndex = 0;
    while ((m = waveInlineRe.exec(line)) !== null) {
      waveNumbers.add(parseInt(m[1], 10));
    }
  }

  return {
    stories: storyIds.size + unnumberedStories,
    waves: waveNumbers.size,
  };
}

const devspecSummaryHandler: HandlerDef = {
  name: 'devspec_summary',
  description:
    'Count structural elements of a Dev Spec file (sections, stories, waves, deliverables) for the /devspec approval summary card',
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

    try {
      const body = await readSpecFile(args.path);
      const lines = body.split('\n');

      const sections = countTopLevelSections(lines);
      const { stories, waves } = countStoriesAndWaves(lines);
      const { active: deliverables_active, na: deliverables_na } = countDeliverables(lines);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              path: args.path,
              sections,
              stories,
              waves,
              deliverables_active,
              deliverables_na,
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

export default devspecSummaryHandler;
