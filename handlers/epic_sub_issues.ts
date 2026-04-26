// Epic-family handler — adapter-dispatching shell. Subprocess + platform
// branching live in lib/adapters/fetch-issue-{github,gitlab}.ts (Story 2.1,
// #295); markdown parsers live in lib/epic-sub-issues-parser.ts (Story 2.6,
// #300). This handler is dispatch + envelope only.

import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { SUB_ISSUE_SECTION_KEYS, findSubIssueSection, parseIssueRef, parseSections, type IssueRef } from '../lib/spec_parser';
import { parseRepoSlug } from '../lib/shared/parse-repo-slug.js';
import { getAdapter } from '../lib/adapters/index.js';
import { parseChecklistOrBullets, parseTableRows } from '../lib/epic-sub-issues-parser.js';

const inputSchema = z.object({
  epic_ref: z.string().min(1, 'epic_ref must be a non-empty string'),
});

function envelope(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

function repoSlug(ref: IssueRef): string | undefined {
  return ref.owner && ref.repo ? `${ref.owner}/${ref.repo}` : undefined;
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
      return envelope({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }

    const ref = parseIssueRef(args.epic_ref);
    if (!ref) {
      return envelope({ ok: false, error: `could not parse epic_ref: '${args.epic_ref}'` });
    }

    const repo = repoSlug(ref);
    const result = await getAdapter({ repo }).fetchIssue({ number: ref.number, repo });
    if ('platform_unsupported' in result) return envelope({ ok: false, error: result.hint });
    if (!result.ok) return envelope({ ok: false, error: result.error });

    const { sections } = parseSections(result.data.body);
    const section = findSubIssueSection(sections);
    if (!section) {
      return envelope({
        ok: true,
        epic_ref: args.epic_ref,
        sub_issues: [],
        count: 0,
        reason: 'no matching sub-issue section found in epic body',
        accepted_sections: [...SUB_ISSUE_SECTION_KEYS],
      });
    }

    // Resolve bare `#N` refs in the epic body against the EPIC's repo, not
    // the MCP process's cwd. Fall back to cwd's slug only when the epic_ref
    // itself was bare (back-compat for same-repo invocations).
    const epicSlug = repo ?? parseRepoSlug();
    // Try table format first; fall back to checklist/bullets if table yields nothing.
    let subs = parseTableRows(section, epicSlug);
    if (subs.length === 0) subs = parseChecklistOrBullets(section, epicSlug);

    return envelope({
      ok: true,
      epic_ref: args.epic_ref,
      sub_issues: subs,
      count: subs.length,
    });
  },
};

export default epicSubIssuesHandler;
