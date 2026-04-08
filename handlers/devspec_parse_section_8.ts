import { z } from 'zod';
import type { HandlerDef } from '../types.js';

const inputSchema = z.object({
  path: z.string().min(1, 'path must be a non-empty string'),
});

interface UnitTest {
  name: string;
  purpose: string;
  file_location: string;
}

interface TestProcedures {
  unit_tests: UnitTest[];
  integration_coverage: string[];
}

interface Story {
  title: string;
  wave: string;
  repo?: string;
  dependencies: string[];
  implementation_steps: string[];
  test_procedures: TestProcedures;
  acceptance_criteria: string[];
}

interface Wave {
  number: string;
  stories: Story[];
}

interface Phase {
  name: string;
  dod_items: string[];
  waves: Wave[];
}

async function readLocalFile(path: string): Promise<string> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`file not found: ${path}`);
  }
  return await file.text();
}

/**
 * Extract the "## 8. Phased Implementation Plan" section from a Dev Spec.
 * Captures everything until the next h2 (`## `).
 */
function extractSection8(markdown: string): string | null {
  const lines = markdown.split('\n');
  let inSection = false;
  const collected: string[] = [];

  for (const line of lines) {
    const h2Match = /^##\s+(.*)$/.exec(line);
    if (h2Match) {
      const title = h2Match[1].trim();
      if (inSection) {
        // Hit the next h2 — end of section.
        break;
      }
      // Match "8. Phased Implementation Plan" (allow optional whitespace).
      if (/^8\.\s+phased\s+implementation\s+plan/i.test(title)) {
        inSection = true;
        continue;
      }
    }
    if (inSection) collected.push(line);
  }

  return inSection ? collected.join('\n') : null;
}

/**
 * Strip a checklist marker like "- [ ]" or "- [x]" from the start of a line
 * and return the remaining text. Returns null if the line is not a checklist
 * item.
 */
function parseChecklistItem(line: string): string | null {
  const m = /^\s*-\s*\[[ xX]\]\s*(.*)$/.exec(line);
  return m ? m[1].trim() : null;
}

/**
 * Parse a numbered list item like "1. step text" or "  2. step". Returns the
 * step text or null.
 */
function parseNumberedItem(line: string): string | null {
  const m = /^\s*\d+\.\s+(.*)$/.exec(line);
  return m ? m[1].trim() : null;
}

/**
 * Parse a bullet list item ("- text" or "* text"). Excludes checklist items.
 */
function parseBulletItem(line: string): string | null {
  if (parseChecklistItem(line) !== null) return null;
  const m = /^\s*[-*]\s+(.*)$/.exec(line);
  return m ? m[1].trim() : null;
}

/**
 * Parse a bolded metadata line like "**Wave:** 2" — return the value, or null.
 */
function parseMetadata(line: string, key: string): string | null {
  const re = new RegExp(`^\\*\\*${key}:\\*\\*\\s*(.*)$`, 'i');
  const m = re.exec(line.trim());
  return m ? m[1].trim() : null;
}

/**
 * Split section 8 content into phase blocks. Returns an array of
 * { name, body } where body is everything between this `### Phase` heading
 * and the next `### Phase` (or `### ` of the same level), exclusive.
 *
 * Non-phase `### ` headings (e.g. "### How to read this section",
 * "### Wave Map") that appear before any phase are skipped.
 */
function splitPhases(section: string): { name: string; body: string }[] {
  const lines = section.split('\n');
  const phases: { name: string; body: string; bodyLines: string[] }[] = [];
  let current: { name: string; bodyLines: string[] } | null = null;

  for (const line of lines) {
    const h3Match = /^###\s+(.*)$/.exec(line);
    if (h3Match) {
      const title = h3Match[1].trim();
      const phaseMatch = /^Phase\s+([^:]+):\s*(.+)$/i.exec(title);
      if (phaseMatch) {
        // Skip template placeholder phases like "Phase N: [[Phase Name]] (Epic)".
        const phaseName = title.replace(/\s*\(Epic\)\s*$/i, '').trim();
        if (/\[\[.*\]\]/.test(phaseName)) {
          // Template placeholder — ignore.
          current = null;
          continue;
        }
        if (current) {
          phases.push({ name: current.name, body: current.bodyLines.join('\n'), bodyLines: current.bodyLines });
        }
        current = { name: phaseName, bodyLines: [] };
        continue;
      }
      // Some other ### heading. If we're inside a phase, treat it as content
      // (it could be a sub-block we don't recognize). If we're not inside a
      // phase, ignore it.
    }
    if (current) current.bodyLines.push(line);
  }

  if (current) {
    phases.push({ name: current.name, body: current.bodyLines.join('\n'), bodyLines: current.bodyLines });
  }

  return phases.map(p => ({ name: p.name, body: p.body }));
}

/**
 * Within a phase body, extract the "Phase N Definition of Done" checklist.
 * Looks for an h4 matching /Definition of Done/i and collects checklist
 * items until the next h4 or h3.
 */
function extractPhaseDoD(phaseBody: string): string[] {
  const lines = phaseBody.split('\n');
  let inDoD = false;
  const items: string[] = [];
  for (const line of lines) {
    const headingMatch = /^(#{3,4})\s+(.*)$/.exec(line);
    if (headingMatch) {
      const title = headingMatch[2].trim();
      if (inDoD) {
        // Any subsequent heading ends the DoD block.
        break;
      }
      if (/definition of done/i.test(title)) {
        inDoD = true;
        continue;
      }
    }
    if (inDoD) {
      const item = parseChecklistItem(line);
      if (item !== null && !/\[\[.*\]\]/.test(item)) {
        items.push(item);
      }
    }
  }
  return items;
}

/**
 * Split a phase body into story blocks. Each story starts with
 * `#### Story N.N: Title`. The block continues until the next `#### Story`
 * heading or the next h3.
 */
function splitStories(phaseBody: string): { title: string; body: string }[] {
  const lines = phaseBody.split('\n');
  const stories: { title: string; bodyLines: string[] }[] = [];
  let current: { title: string; bodyLines: string[] } | null = null;

  for (const line of lines) {
    const h3Match = /^###\s+/.exec(line);
    if (h3Match) {
      // h3 ends any current story (shouldn't normally happen inside a phase).
      if (current) {
        stories.push(current);
        current = null;
      }
      continue;
    }
    const h4Match = /^####\s+(.*)$/.exec(line);
    if (h4Match) {
      const title = h4Match[1].trim();
      const storyMatch = /^Story\s+[^:]+:\s*(.+)$/i.exec(title);
      if (storyMatch) {
        const storyTitle = storyMatch[1].trim();
        // Skip template placeholders like "Story N.N: [[Story Title]]".
        if (/\[\[.*\]\]/.test(storyTitle)) {
          current = null;
          continue;
        }
        if (current) stories.push(current);
        current = { title: storyTitle, bodyLines: [] };
        continue;
      }
      // A non-Story #### heading ends any current story.
      if (current) {
        stories.push(current);
        current = null;
        continue;
      }
    }
    if (current) current.bodyLines.push(line);
  }
  if (current) stories.push(current);

  return stories.map(s => ({ title: s.title, body: s.bodyLines.join('\n') }));
}

/**
 * Find the line range for a "**Label:**" block — from the line containing
 * the bolded label to (exclusive) the next bolded label, h-heading, or
 * end-of-input.
 */
function blockAfterLabel(lines: string[], labelRegex: RegExp): string[] {
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (labelRegex.test(lines[i].trim())) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return [];
  const block: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    // Stop at the next bolded label (e.g. "**Acceptance Criteria:**") or any heading.
    if (/^\*\*[^*]+:\*\*/.test(line.trim())) break;
    if (/^#{1,6}\s/.test(line)) break;
    block.push(line);
  }
  return block;
}

/**
 * Parse a story body into a Story object. Returns null if the story is
 * malformed (no Wave metadata is OK — it defaults to 'ungrouped').
 */
function parseStory(title: string, body: string, warnings: string[]): Story | null {
  const lines = body.split('\n');

  // Metadata lines (Wave / Repository / Dependencies) usually appear at the
  // top of the story before any **bolded section** label.
  let wave = 'ungrouped';
  let repo: string | undefined;
  let dependencies: string[] = [];

  for (const line of lines) {
    const w = parseMetadata(line, 'Wave');
    if (w !== null && !/\[\[.*\]\]/.test(w)) {
      wave = w;
      continue;
    }
    const r = parseMetadata(line, 'Repository');
    if (r !== null && r.length > 0 && !/\[\[.*\]\]/.test(r)) {
      repo = r;
      continue;
    }
    const d = parseMetadata(line, 'Dependencies');
    if (d !== null && !/\[\[.*\]\]/.test(d)) {
      // "None" → empty list. Otherwise split on comma.
      if (/^none$/i.test(d.trim())) {
        dependencies = [];
      } else {
        dependencies = d.split(',').map(s => s.trim()).filter(Boolean);
      }
    }
  }

  // Implementation Steps — numbered list.
  const implBlock = blockAfterLabel(lines, /^\*\*Implementation Steps:\*\*/i);
  const implementation_steps: string[] = [];
  for (const line of implBlock) {
    const step = parseNumberedItem(line);
    if (step !== null && !/\[\[.*\]\]/.test(step)) {
      implementation_steps.push(step);
    }
  }

  // Test Procedures — contains a unit-tests table and integration coverage bullets.
  const testBlock = blockAfterLabel(lines, /^\*\*Test Procedures:\*\*/i);
  const test_procedures = parseTestProcedures(testBlock);

  // Acceptance Criteria — checklist.
  const acBlock = blockAfterLabel(lines, /^\*\*Acceptance Criteria:\*\*/i);
  const acceptance_criteria: string[] = [];
  for (const line of acBlock) {
    const item = parseChecklistItem(line);
    if (item !== null && !/\[\[.*\]\]/.test(item)) {
      acceptance_criteria.push(item);
    }
  }

  // Sanity check: a story is "real" if it has at least one of impl steps, AC,
  // or test procedures. Otherwise it's likely a malformed entry — skip with warning.
  if (
    implementation_steps.length === 0 &&
    acceptance_criteria.length === 0 &&
    test_procedures.unit_tests.length === 0 &&
    test_procedures.integration_coverage.length === 0
  ) {
    warnings.push(`story "${title}" has no implementation steps, acceptance criteria, or test procedures — skipping`);
    return null;
  }

  const story: Story = {
    title,
    wave,
    dependencies,
    implementation_steps,
    test_procedures,
    acceptance_criteria,
  };
  if (repo !== undefined) story.repo = repo;
  return story;
}

/**
 * Parse the "Test Procedures" block — a *Unit Tests:* table plus
 * *Integration/E2E Coverage:* bullets.
 */
function parseTestProcedures(block: string[]): TestProcedures {
  const unit_tests: UnitTest[] = [];
  const integration_coverage: string[] = [];

  // Find the "Unit Tests" sub-label and parse the table that follows.
  let unitStart = -1;
  let intStart = -1;
  for (let i = 0; i < block.length; i++) {
    const line = block[i].trim();
    if (/^\*?unit\s*tests:?\*?$/i.test(line) || /^\*unit\s*tests:\*$/i.test(line)) {
      unitStart = i + 1;
    } else if (/^\*?integration(\/e2e)?\s*coverage:?\*?$/i.test(line) || /^\*integration\/e2e\s*coverage:\*$/i.test(line)) {
      intStart = i + 1;
    }
  }

  // Parse the unit tests table.
  if (unitStart !== -1) {
    const tableEnd = intStart !== -1 && intStart > unitStart ? intStart - 1 : block.length;
    const tableLines = block.slice(unitStart, tableEnd);
    parseUnitTestsTable(tableLines, unit_tests);
  }

  // Parse integration coverage bullets.
  if (intStart !== -1) {
    const bulletLines = block.slice(intStart);
    for (const line of bulletLines) {
      const item = parseBulletItem(line);
      if (item !== null && !/\[\[.*\]\]/.test(item)) {
        integration_coverage.push(item);
      }
    }
  }

  return { unit_tests, integration_coverage };
}

function parseUnitTestsTable(lines: string[], out: UnitTest[]): void {
  // Find the header row.
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith('|') && /test\s*name/i.test(t)) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return;

  const headerCells = lines[headerIdx]
    .trim()
    .split('|')
    .slice(1, -1)
    .map(c => c.trim().toLowerCase());

  const nameCol = headerCells.findIndex(c => c.includes('name'));
  const purposeCol = headerCells.findIndex(c => c.includes('purpose'));
  const fileCol = headerCells.findIndex(c => c.includes('file') || c.includes('location'));

  // Skip the separator row.
  let startRow = headerIdx + 1;
  if (startRow < lines.length && /^\|[\s\-:|]+\|$/.test(lines[startRow].trim())) {
    startRow += 1;
  }

  for (let i = startRow; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('|')) break;
    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    const get = (idx: number) => (idx >= 0 && idx < cells.length ? stripBackticks(cells[idx]) : '');
    const name = get(nameCol);
    if (!name || /\[\[.*\]\]/.test(name)) continue;
    out.push({
      name,
      purpose: get(purposeCol),
      file_location: get(fileCol),
    });
  }
}

function stripBackticks(s: string): string {
  return s.replace(/^`(.*)`$/, '$1');
}

/**
 * Group stories into waves. The wave key is the story's `wave` metadata
 * field (string). Returns waves sorted by numeric wave number when possible,
 * with 'ungrouped' last.
 */
function groupIntoWaves(stories: Story[]): Wave[] {
  const map = new Map<string, Story[]>();
  for (const story of stories) {
    const key = story.wave || 'ungrouped';
    const list = map.get(key) ?? [];
    list.push(story);
    map.set(key, list);
  }

  const waves: Wave[] = [];
  for (const [number, list] of map.entries()) {
    waves.push({ number, stories: list });
  }
  waves.sort((a, b) => {
    if (a.number === 'ungrouped') return 1;
    if (b.number === 'ungrouped') return -1;
    const an = parseInt(a.number, 10);
    const bn = parseInt(b.number, 10);
    if (Number.isNaN(an) && Number.isNaN(bn)) return a.number.localeCompare(b.number);
    if (Number.isNaN(an)) return 1;
    if (Number.isNaN(bn)) return -1;
    return an - bn;
  });
  return waves;
}

const devspecParseSection8Handler: HandlerDef = {
  name: 'devspec_parse_section_8',
  description:
    'Parse Section 8 (Phased Implementation Plan) of a Dev Spec into a structured phase / wave / story tree for backlog upshift',
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
      const body = await readLocalFile(args.path);
      const section = extractSection8(body);
      if (section === null) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: 'no Section 8 (Phased Implementation Plan) found in Dev Spec',
              }),
            },
          ],
        };
      }

      const warnings: string[] = [];
      const phaseBlocks = splitPhases(section);
      const phases: Phase[] = [];

      for (const phaseBlock of phaseBlocks) {
        const dod_items = extractPhaseDoD(phaseBlock.body);
        const storyBlocks = splitStories(phaseBlock.body);
        const stories: Story[] = [];
        for (const sb of storyBlocks) {
          const story = parseStory(sb.title, sb.body, warnings);
          if (story !== null) stories.push(story);
        }
        const waves = groupIntoWaves(stories);
        phases.push({ name: phaseBlock.name, dod_items, waves });
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              path: args.path,
              phases,
              warnings,
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

export default devspecParseSection8Handler;
