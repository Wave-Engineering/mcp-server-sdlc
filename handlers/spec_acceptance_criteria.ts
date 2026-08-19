// Spec-family handler — adapter-dispatching shell.
// Subprocess + platform branching live in lib/adapters/fetch-issue-{github,gitlab}.ts
// (Story 2.1, #295); this handler consumes the normalized `AdapterIssue` shape
// via `getAdapter().fetchIssue(...)`. Checklist-regex parsing stays here — it's
// platform-agnostic.

import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { parseIssueRef, parseSections, type IssueRef } from '../lib/spec_parser';
import { getAdapter } from '../lib/adapters/index.js';

const inputSchema = z.object({
  issue_ref: z.string().min(1, 'issue_ref must be a non-empty string'),
});

interface ChecklistItem {
  text: string;
  checked: boolean;
  position: number;
}

function envelope(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

function repoSlug(ref: IssueRef): string | undefined {
  return ref.owner && ref.repo ? `${ref.owner}/${ref.repo}` : undefined;
}

// Parse markdown checklist items (`- [ ] text` / `- [x] text`). Position is
// the order of appearance starting from 1.
function parseChecklist(section: string): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  if (!section) return items;
  const re = /^\s*[-*]\s*\[([ xX])\]\s*(.*?)$/gm;
  let m: RegExpExecArray | null;
  let position = 1;
  while ((m = re.exec(section)) !== null) {
    items.push({ text: m[2].trim(), checked: m[1].toLowerCase() === 'x', position: position++ });
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
      return envelope({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }

    const ref = parseIssueRef(args.issue_ref);
    if (!ref) {
      return envelope({ ok: false, error: `could not parse issue_ref: '${args.issue_ref}'` });
    }

    const repo = repoSlug(ref);
    const result = await getAdapter({ repo }).fetchIssue({ number: ref.number, repo });
    if ('platform_unsupported' in result) return envelope({ ok: false, error: result.hint });
    if (!result.ok) return envelope({ ok: false, code: result.code, error: result.error });

    const { sections } = parseSections(result.data.body);
    const items = parseChecklist(sections.acceptance_criteria ?? '');
    return envelope({ ok: true, issue_ref: args.issue_ref, criteria: items, count: items.length });
  },
};

export default specAcceptanceCriteriaHandler;
