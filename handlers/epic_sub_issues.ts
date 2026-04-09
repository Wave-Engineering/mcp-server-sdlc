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
 * Accepts "Sub-Issues", "Sub Issues", "Sub-issues", "Children", "Tasks".
 */
function findSubIssueSection(sections: Record<string, string>): string | null {
  const keys = ['sub_issues', 'subissues', 'children', 'tasks', 'task_list'];
  for (const k of keys) {
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
    // Title = text with the ref token stripped out.
    const title = text.replace(refM[0], '').trim().replace(/^[-:*\s]+/, '').trim();
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
  description: "Extract sub-issue references from an epic's body",
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
