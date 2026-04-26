import { execSync } from 'child_process';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { parseIssueRef, parseSections, type IssueRef } from '../lib/spec_parser';
import { detectPlatform } from '../lib/shared/detect-platform.js';
import { gitlabApiIssue } from '../lib/glab.js';

const inputSchema = z.object({
  issue_ref: z.string().min(1, 'issue_ref must be a non-empty string'),
});

interface ChecklistItem {
  text: string;
  checked: boolean;
  position: number;
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

/**
 * Parse markdown checklist items: `- [ ] text` or `- [x] text`.
 * Position is the order of appearance starting from 1.
 */
function parseChecklist(section: string): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  if (!section) return items;
  const re = /^\s*[-*]\s*\[([ xX])\]\s*(.*?)$/gm;
  let m: RegExpExecArray | null;
  let position = 1;
  while ((m = re.exec(section)) !== null) {
    items.push({
      text: m[2].trim(),
      checked: m[1].toLowerCase() === 'x',
      position: position++,
    });
  }
  return items;
}

const specAcceptanceCriteriaHandler: HandlerDef = {
  name: 'spec_acceptance_criteria',
  description: 'Extract the Acceptance Criteria checklist as structured items',
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

    const ref = parseIssueRef(args.issue_ref);
    if (!ref) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: `could not parse issue_ref: '${args.issue_ref}'`,
            }),
          },
        ],
      };
    }

    try {
      const body = fetchBody(ref);
      const { sections } = parseSections(body);
      const acSection = sections.acceptance_criteria ?? '';
      const items = parseChecklist(acSection);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              issue_ref: args.issue_ref,
              criteria: items,
              count: items.length,
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

export default specAcceptanceCriteriaHandler;
