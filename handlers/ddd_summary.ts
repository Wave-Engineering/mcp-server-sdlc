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
 * Read a Domain Model markdown file from disk.
 *
 * Per `lesson_mcp_gotchas.md` and `devspec_summary.ts` precedent, this
 * handler uses `Bun.file()` for local file reads (not `fs`, not shell-out).
 */
async function readDomainModelFile(path: string): Promise<string> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`file not found: ${path}`);
  }
  return await file.text();
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
 * Count unique `E-NN` identifiers inside Section 3 (Domain Events).
 *
 * The template organises events under `### Phase: ...` subsections, each
 * with a markdown table whose first column contains `E-01`, `E-02`, etc.
 * We scan the entire section body and collect unique IDs of the shape
 * `E-<digits>` so that repeats across phases (or the summary row) are not
 * double-counted.
 */
function countEvents(lines: string[]): number {
  const section = findTopLevelSection(lines, 3);
  if (!section) return 0;

  const ids = new Set<string>();
  const idRe = /\bE-(\d+)\b/g;
  for (let i = section.start; i < section.end; i++) {
    const line = lines[i];
    let m: RegExpExecArray | null;
    idRe.lastIndex = 0;
    while ((m = idRe.exec(line)) !== null) {
      ids.add(`E-${m[1]}`);
    }
  }
  return ids.size;
}

/**
 * Count unique `C-NN` identifiers inside Section 4 (Commands).
 *
 * Section 4 has a single `## 4. Commands` heading and a markdown table with
 * `C-01`, `C-02`, ... rows. We collect unique IDs to tolerate back-references
 * in Key Insights bullets.
 */
function countCommands(lines: string[]): number {
  const section = findTopLevelSection(lines, 4);
  if (!section) return 0;

  const ids = new Set<string>();
  const idRe = /\bC-(\d+)\b/g;
  for (let i = section.start; i < section.end; i++) {
    const line = lines[i];
    let m: RegExpExecArray | null;
    idRe.lastIndex = 0;
    while ((m = idRe.exec(line)) !== null) {
      ids.add(`C-${m[1]}`);
    }
  }
  return ids.size;
}

/**
 * Count rows in Section 5 (Actors) responsibility matrix.
 *
 * Section 5 contains a `### Responsibility Matrix` subsection with a
 * markdown table whose columns are `Actor | Commands | Responsibility`.
 * We count data rows — lines starting with `|`, excluding the header and
 * separator, and skipping rows whose cells are all template placeholders
 * (empty or wrapped in `[[...]]`). Only the FIRST table in the section is
 * counted (the Actor Pattern Summary table that follows has different
 * semantics and should not inflate the actor count).
 */
function countActors(lines: string[]): number {
  const section = findTopLevelSection(lines, 5);
  if (!section) return 0;

  const sectionLines = lines.slice(section.start, section.end);

  // Find the first markdown table header (a row starting with `|`).
  let headerIdx = -1;
  for (let i = 0; i < sectionLines.length; i++) {
    const trimmed = sectionLines[i].trim();
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return 0;

  // Skip the separator row `|---|---|`.
  let startRow = headerIdx + 1;
  if (
    startRow < sectionLines.length &&
    /^\|[\s\-:|]+\|$/.test(sectionLines[startRow].trim())
  ) {
    startRow += 1;
  }

  let count = 0;
  for (let i = startRow; i < sectionLines.length; i++) {
    const trimmed = sectionLines[i].trim();
    if (!trimmed.startsWith('|')) {
      // Table ended.
      break;
    }
    const cells = trimmed.split('|').slice(1, -1).map(c => c.trim());
    if (cells.length === 0) continue;

    // Skip rows whose cells are all empty or pure `[[...]]` placeholders.
    const meaningful = cells.some(c => c.length > 0 && !/^\[\[.*\]\]$/.test(c));
    if (!meaningful) continue;

    count += 1;
  }

  return count;
}

/**
 * Count unique `P-NN` identifiers inside Section 6 (Policies).
 *
 * Section 6 contains multiple subsections (6.1 Cascade, 6.2 Quality, 6.3
 * Notification, 6.4 Loop) each with its own table. We scan the entire
 * section body and collect unique IDs of the shape `P-<digits>` so that
 * Key Insights back-references don't double-count.
 */
function countPolicies(lines: string[]): number {
  const section = findTopLevelSection(lines, 6);
  if (!section) return 0;

  const ids = new Set<string>();
  const idRe = /\bP-(\d+)\b/g;
  for (let i = section.start; i < section.end; i++) {
    const line = lines[i];
    let m: RegExpExecArray | null;
    idRe.lastIndex = 0;
    while ((m = idRe.exec(line)) !== null) {
      ids.add(`P-${m[1]}`);
    }
  }
  return ids.size;
}

/**
 * Count aggregate subsections inside Section 7 (Aggregates).
 *
 * The template puts each aggregate under `#### <Name>` (h4) within `### 7.1
 * Core Aggregates`. We count every h4 heading inside Section 7 — Section
 * 7.2 and 7.3 are h3 subsections and are not counted. The "(Root
 * Aggregate)" suffix on the first h4 is tolerated.
 */
function countAggregates(lines: string[]): number {
  const section = findTopLevelSection(lines, 7);
  if (!section) return 0;

  let count = 0;
  for (let i = section.start; i < section.end; i++) {
    // h4 heading: `#### Something` but not `##### Something`.
    if (/^####\s+\S/.test(lines[i]) && !/^#####/.test(lines[i])) {
      count += 1;
    }
  }
  return count;
}

/**
 * Count unique `RM-NN` identifiers inside Section 8 (Read Models).
 *
 * Section 8 contains multiple subsections (8.1 For X, 8.2 For Y, ...) each
 * with its own table of `RM-01`, `RM-02`, ... rows. We collect unique IDs
 * so that Key Insights back-references don't double-count.
 */
function countReadModels(lines: string[]): number {
  const section = findTopLevelSection(lines, 8);
  if (!section) return 0;

  const ids = new Set<string>();
  const idRe = /\bRM-(\d+)\b/g;
  for (let i = section.start; i < section.end; i++) {
    const line = lines[i];
    let m: RegExpExecArray | null;
    idRe.lastIndex = 0;
    while ((m = idRe.exec(line)) !== null) {
      ids.add(`RM-${m[1]}`);
    }
  }
  return ids.size;
}

const dddSummaryHandler: HandlerDef = {
  name: 'ddd_summary',
  description:
    'Count structural elements of a Domain Model file (events, commands, actors, policies, aggregates, read models) for the /ddd accept handoff summary',
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
      const body = await readDomainModelFile(args.path);
      const lines = body.split('\n');

      const events = countEvents(lines);
      const commands = countCommands(lines);
      const actors = countActors(lines);
      const policies = countPolicies(lines);
      const aggregates = countAggregates(lines);
      const read_models = countReadModels(lines);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              path: args.path,
              events,
              commands,
              actors,
              policies,
              aggregates,
              read_models,
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

export default dddSummaryHandler;
