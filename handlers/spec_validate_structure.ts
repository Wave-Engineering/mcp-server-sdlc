// Adapter-dispatching shell — subprocess + platform branching live in
// lib/adapters/fetch-issue-{github,gitlab}.ts (Story 2.1, #295). H2-section
// validation + bold-label dependencies fallback is platform-agnostic and stays
// here. See docs/issue-body-grammar.md.

import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { findBoldLabelDependencies, parseIssueRef, parseSections, type IssueRef } from '../lib/spec_parser';
import { getAdapter } from '../lib/adapters/index.js';

const inputSchema = z.object({ issue_ref: z.string().min(1, 'issue_ref must be a non-empty string') });

// Canonical key → accepted H2 heading aliases (after normalizeHeading).
const REQUIRED: Record<string, readonly string[]> = {
  changes: ['changes', 'implementation_steps'],
  tests: ['tests', 'test_procedures'],
  acceptance_criteria: ['acceptance_criteria'],
};
const OPTIONAL: Record<string, readonly string[]> = { dependencies: ['dependencies'] };

const acceptedHeadings = (aliases: readonly string[]) =>
  aliases.map((a) => `## ${a.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}`);
const envelope = (payload: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(payload) }] });
const repoSlug = (ref: IssueRef) => (ref.owner && ref.repo ? `${ref.owner}/${ref.repo}` : undefined);
const hasSection = (sections: Record<string, string>, aliases: readonly string[]) =>
  aliases.some((a) => sections[a] && sections[a].trim().length > 0);

const specValidateStructureHandler: HandlerDef = {
  name: 'spec_validate_structure',
  description:
    'Check for presence of required sections in an issue spec. Accepts H2 heading aliases: `## Changes` or `## Implementation Steps`; `## Tests` or `## Test Procedures`; `## Acceptance Criteria`. Optional: `## Dependencies` (or a `**Dependencies:**` bold-label inside any other section, mirroring spec_dependencies). See docs/issue-body-grammar.md.',
  inputSchema,
  async execute(rawArgs: unknown) {
    let args: z.infer<typeof inputSchema>;
    try {
      args = inputSchema.parse(rawArgs);
    } catch (err) {
      return envelope({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    const ref = parseIssueRef(args.issue_ref);
    if (!ref) return envelope({ ok: false, error: `could not parse issue_ref: '${args.issue_ref}'` });

    const repo = repoSlug(ref);
    const result = await getAdapter({ repo }).fetchIssue({ number: ref.number, repo });
    if ('platform_unsupported' in result) return envelope({ ok: false, error: result.hint });
    if (!result.ok) return envelope({ ok: false, code: result.code, error: result.error });

    const { sections } = parseSections(result.data.body);
    const presence: Record<string, boolean> = {};
    const missing: string[] = [];
    const acceptedHint: Record<string, string[]> = {};
    for (const [k, aliases] of Object.entries(REQUIRED)) {
      const has = hasSection(sections, aliases);
      presence[`has_${k}`] = has;
      if (!has) {
        missing.push(k);
        acceptedHint[k] = acceptedHeadings(aliases);
      }
    }
    for (const [k, aliases] of Object.entries(OPTIONAL)) presence[`has_${k}`] = hasSection(sections, aliases);
    // Bold-label fallback for has_dependencies only (parity with spec_dependencies).
    if (!presence.has_dependencies && findBoldLabelDependencies(sections)) presence.has_dependencies = true;

    const response: Record<string, unknown> = {
      ok: true,
      issue_ref: args.issue_ref,
      ...presence,
      missing_sections: missing,
      valid: missing.length === 0,
    };
    if (missing.length > 0) response.accepted_headings = acceptedHint;
    return envelope(response);
  },
};

export default specValidateStructureHandler;
