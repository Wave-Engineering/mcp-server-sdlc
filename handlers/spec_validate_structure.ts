import { execSync } from 'child_process';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { findBoldLabelDependencies, parseIssueRef, parseSections, type IssueRef } from '../lib/spec_parser';
import { detectPlatform, gitlabApiIssue } from '../lib/glab';

const inputSchema = z.object({
  issue_ref: z.string().min(1, 'issue_ref must be a non-empty string'),
});

// Canonical section keys → accepted H2 heading aliases (after normalizeHeading).
// `## Changes` or `## Implementation Steps` both satisfy the `changes` requirement;
// `## Tests` or `## Test Procedures` both satisfy `tests`. See docs/issue-body-grammar.md.
const REQUIRED_SECTION_ALIASES: Record<string, readonly string[]> = {
  changes: ['changes', 'implementation_steps'],
  tests: ['tests', 'test_procedures'],
  acceptance_criteria: ['acceptance_criteria'],
};
const OPTIONAL_SECTION_ALIASES: Record<string, readonly string[]> = {
  dependencies: ['dependencies'],
};

function acceptedHeadings(aliases: readonly string[]): string[] {
  return aliases.map((a) => `## ${a.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}`);
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

      const presence: Record<string, boolean> = {};
      const missing: string[] = [];
      const acceptedHeadingsHint: Record<string, string[]> = {};
      for (const [canonical, aliases] of Object.entries(REQUIRED_SECTION_ALIASES)) {
        const has = aliases.some(
          (alias) => sections[alias] && sections[alias].trim().length > 0,
        );
        presence[`has_${canonical}`] = has;
        if (!has) {
          missing.push(canonical);
          acceptedHeadingsHint[canonical] = acceptedHeadings(aliases);
        }
      }
      for (const [canonical, aliases] of Object.entries(OPTIONAL_SECTION_ALIASES)) {
        presence[`has_${canonical}`] = aliases.some(
          (alias) => sections[alias] && sections[alias].trim().length > 0,
        );
      }
      // Bold-label fallback for `has_dependencies` only (mirrors
      // spec_dependencies' fallback). Stories that embed deps as
      // `**Dependencies:** #5, #6` inside ## Metadata count as declared.
      // The narrow scope is deliberate — implementation/test sections must
      // remain strict because they carry semantic content, not metadata.
      // Truthiness check matches the idiom in spec_dependencies (the helper
      // returns `''` when no label is present or its content is empty).
      if (!presence.has_dependencies && findBoldLabelDependencies(sections)) {
        presence.has_dependencies = true;
      }

      const response: Record<string, unknown> = {
        ok: true,
        issue_ref: args.issue_ref,
        ...presence,
        missing_sections: missing,
        valid: missing.length === 0,
      };
      if (missing.length > 0) {
        response.accepted_headings = acceptedHeadingsHint;
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response) }],
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error }) }],
      };
    }
  },
};

export default specValidateStructureHandler;
