import { execSync } from 'child_process';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { parseIssueRef, parseSections, type IssueRef } from '../lib/spec_parser';
import { detectPlatform, parseRepoSlug, gitlabApiIssue } from '../lib/glab';

const inputSchema = z.object({
  epic_ref: z.string().min(1, 'epic_ref must be a non-empty string'),
});

interface SubIssue {
  ref: string;
  title?: string;
  order?: number;
}

function fetchBody(ref: IssueRef): string {
  const platform = detectPlatform();
  if (platform === 'github') {
    const repoArg = ref.owner && ref.repo ? `--repo ${ref.owner}/${ref.repo}` : '';
    const cmd = `gh issue view ${ref.number} ${repoArg} --json body`.trim();
    const raw = execSync(cmd, { encoding: 'utf8' });
    return (JSON.parse(raw) as { body: string }).body ?? '';
  }
  const result = gitlabApiIssue(ref.number, ref.owner && ref.repo ? { owner: ref.owner, repo: ref.repo } : undefined);
  return result.description ?? '';
}

function normalizeRef(ref: string, currentSlug: string | null): string {
  // URL
  const urlM =
    /https?:\/\/(?:github\.com|gitlab\.com)\/([^\s/]+)\/([^\s/]+)\/(?:-\/)?issues\/(\d+)/.exec(
      ref,
    );
  if (urlM) return `${urlM[1]}/${urlM[2]}#${urlM[3]}`;

  const crossM = /^([^/\s#]+)\/([^/\s#]+)#(\d+)$/.exec(ref);
  if (crossM) return ref;

  const shortM = /^#?(\d+)$/.exec(ref);
  if (shortM) {
    return currentSlug ? `${currentSlug}#${shortM[1]}` : `#${shortM[1]}`;
  }
  return ref;
}

/**
 * Find which section of the parsed body contains the sub-issues.
 * Accepts (as normalized H2 heading keys):
 *   - Explicit: sub_issues, subissues, children, tasks, task_list
 *   - Wave-plan shape: waves, wave_map, phases, phased_implementation_plan,
 *     implementation_plan, stories, backlog
 *
 * The wave-plan aliases let `/devspec upshift`-generated Epic bodies
 * (which group `#NN` refs under `### Wave N` H3 headings inside a
 * `## Waves` H2) parse without requiring a rename.
 */
const SUB_ISSUE_SECTION_KEYS = [
  'sub_issues',
  'subissues',
  'children',
  'tasks',
  'task_list',
  'waves',
  'wave_map',
  'phases',
  'phased_implementation_plan',
  'implementation_plan',
  'stories',
  'backlog',
] as const;

function findSubIssueSection(sections: Record<string, string>): string | null {
  for (const k of SUB_ISSUE_SECTION_KEYS) {
    if (sections[k]) return sections[k];
  }
  return null;
}

function parseTableRows(section: string, currentSlug: string | null): SubIssue[] {
  const lines = section.split('\n').map(l => l.trim());
  const subs: SubIssue[] = [];
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('|') && lines[i].includes('|', 1)) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return [];
  const headerCells = lines[headerIdx]
    .split('|')
    .slice(1, -1)
    .map(c => c.trim().toLowerCase());
  const colIdx = (name: string) => headerCells.findIndex(c => c.includes(name));
  const orderCol = colIdx('order');
  const issueCol = colIdx('issue');
  const titleCol = colIdx('title');

  let startRow = headerIdx + 1;
  if (startRow < lines.length && /^\|[\s\-:|]+\|$/.test(lines[startRow])) startRow += 1;

  for (let i = startRow; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('|')) break;
    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    const getCell = (idx: number) => (idx >= 0 && idx < cells.length ? cells[idx] : '');
    const issueRaw = getCell(issueCol);
    const refM = /#?(\d+)|([^/\s#]+)\/([^/\s#]+)#(\d+)/.exec(issueRaw);
    if (!refM) continue;
    const ref = normalizeRef(issueRaw, currentSlug);
    const order = orderCol >= 0 ? parseInt(getCell(orderCol), 10) : undefined;
    const title = titleCol >= 0 ? getCell(titleCol) : undefined;
    subs.push({
      ref,
      title: title && title.length > 0 ? title : undefined,
      order: Number.isFinite(order) ? (order as number) : undefined,
    });
  }
  return subs;
}

function parseChecklistOrBullets(section: string, currentSlug: string | null): SubIssue[] {
  const subs: SubIssue[] = [];
  const checklistRe = /^\s*[-*]\s*(?:\[[ xX]\]\s*)?([^\n]*)$/gm;
  let m: RegExpExecArray | null;
  let position = 1;
  while ((m = checklistRe.exec(section)) !== null) {
    const text = m[1].trim();
    if (!text) continue;
    const refM =
      /(?:^|\s)([^/\s#]+\/[^/\s#]+#\d+|https?:\/\/\S+\/issues\/\d+|#\d+)/.exec(text);
    if (!refM) continue;
    const raw = refM[1];
    const ref = normalizeRef(raw, currentSlug);
    // Title = text with the ref token stripped out. Also strip leading
    // list/separator punctuation including em/en dashes commonly used in
    // `- #NN — Title` style bullets.
    const title = text.replace(refM[0], '').trim().replace(/^[-:*\s—–]+/, '').trim();
    subs.push({
      ref,
      title: title.length > 0 ? title : undefined,
      order: position,
    });
    position += 1;
  }
  return subs;
}

const epicSubIssuesHandler: HandlerDef = {
  name: 'epic_sub_issues',
  description:
    "Extract sub-issue references from an epic's body. Accepts H2 sections named: `## Sub-Issues` (or Children/Tasks/Task List), `## Waves` (or Wave Map/Phases/Phased Implementation Plan/Implementation Plan/Stories/Backlog). Content may be a table with Order/Issue/Title columns, or a checklist/bullet list with `#NN` refs. See docs/issue-body-grammar.md.",
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

    const ref = parseIssueRef(args.epic_ref);
    if (!ref) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: `could not parse epic_ref: '${args.epic_ref}'`,
            }),
          },
        ],
      };
    }

    try {
      const body = fetchBody(ref);
      const { sections } = parseSections(body);
      const section = findSubIssueSection(sections);
      if (!section) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: true,
                epic_ref: args.epic_ref,
                sub_issues: [],
                count: 0,
                reason: 'no matching sub-issue section found in epic body',
                accepted_sections: [...SUB_ISSUE_SECTION_KEYS],
              }),
            },
          ],
        };
      }

      const slug = parseRepoSlug();
      // Try table format first; if it yields nothing, fall back to checklist/bullets.
      let subs = parseTableRows(section, slug);
      if (subs.length === 0) {
        subs = parseChecklistOrBullets(section, slug);
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              epic_ref: args.epic_ref,
              sub_issues: subs,
              count: subs.length,
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

export default epicSubIssuesHandler;
