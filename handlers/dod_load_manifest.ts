import { execSync } from 'child_process';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { detectPlatform } from '../lib/shared/detect-platform.js';
import { gitlabApiIssue } from '../lib/glab.js';

const inputSchema = z.object({
  path: z.string().min(1, 'path must be a non-empty string'),
});

interface Deliverable {
  id: string;
  description: string;
  evidence_path: string;
  status: string;
  category: string;
}

const ISSUE_REF = /^([^/]+)\/([^/#]+)#(\d+)$/;
const SHORT_REF = /^#(\d+)$/;

function isIssueRef(path: string): boolean {
  return ISSUE_REF.test(path) || SHORT_REF.test(path);
}

function fetchIssueBody(ref: string): string {
  const platform = detectPlatform();
  if (platform === 'github') {
    const m1 = ISSUE_REF.exec(ref);
    const m2 = SHORT_REF.exec(ref);
    if (m1) {
      const raw = execSync(`gh issue view ${m1[3]} --repo ${m1[1]}/${m1[2]} --json body`, {
        encoding: 'utf8',
      });
      return (JSON.parse(raw) as { body: string }).body;
    }
    if (m2) {
      const raw = execSync(`gh issue view ${m2[1]} --json body`, { encoding: 'utf8' });
      return (JSON.parse(raw) as { body: string }).body;
    }
  } else {
    const m2 = SHORT_REF.exec(ref);
    if (m2) {
      const result = gitlabApiIssue(Number(m2[1]));
      return result.description ?? '';
    }
  }
  throw new Error(`unsupported issue ref format: ${ref}`);
}

async function readLocalFile(path: string): Promise<string> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`file not found: ${path}`);
  }
  return await file.text();
}

/**
 * Extract the "Deliverables Manifest" section from a PRD markdown body.
 *
 * Looks for a heading matching /^##+\s*deliverables manifest/i, then
 * captures everything until the next same-or-lower level heading.
 */
function extractManifestSection(markdown: string): string | null {
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
function parseManifestTable(sectionMd: string): { deliverables: Deliverable[]; warnings: string[] } {
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

  const colIdx = (name: string): number => {
    return headerCells.findIndex(c => c.includes(name));
  };

  const idCol = colIdx('id');
  const descCol = colIdx('description');
  const pathCol = Math.max(colIdx('evidence'), colIdx('path'));
  const statusCol = colIdx('status');
  const catCol = colIdx('category');

  // Skip separator line (|---|---|)
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

const dodLoadManifestHandler: HandlerDef = {
  name: 'dod_load_manifest',
  description: 'Load and parse a Deliverables Manifest from a PRD file or issue reference',
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
      const body = isIssueRef(args.path)
        ? fetchIssueBody(args.path)
        : await readLocalFile(args.path);

      const section = extractManifestSection(body);
      if (section === null) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: 'no Deliverables Manifest section found in PRD',
              }),
            },
          ],
        };
      }

      const { deliverables, warnings } = parseManifestTable(section);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              deliverables,
              warnings,
              source: args.path,
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

export default dodLoadManifestHandler;
