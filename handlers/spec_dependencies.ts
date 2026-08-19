// Spec-family handler — adapter-dispatching shell. Subprocess + platform
// branching live in lib/adapters/fetch-issue-{github,gitlab}.ts (Story 2.1,
// #295). Section + bold-label parsing stays handler-side via lib/spec_parser
// (platform-agnostic).

import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import {
  findBoldLabelDependencies,
  parseDependenciesSection,
  parseIssueRef,
  parseSections,
  type IssueRef,
} from '../lib/spec_parser';
import { parseRepoSlug } from '../lib/shared/parse-repo-slug.js';
import { getAdapter } from '../lib/adapters/index.js';

const inputSchema = z.object({
  issue_ref: z.string().min(1, 'issue_ref must be a non-empty string'),
});

function envelope(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

function repoSlug(ref: IssueRef): string | undefined {
  return ref.owner && ref.repo ? `${ref.owner}/${ref.repo}` : undefined;
}

const specDependenciesHandler: HandlerDef = {
  name: 'spec_dependencies',
  description:
    "Extract the list of dependency issue references from an issue spec. Primary source: `## Dependencies` H2 section. Fallback: a `**Dependencies:**` bold label inside any other section (e.g. `## Metadata`). Accepts `#N`, `org/repo#N`, and full GitHub/GitLab issue URLs. See docs/issue-body-grammar.md.",
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
    let depsSection = sections.dependencies ?? '';
    let source: 'dependencies_section' | 'bold_label_fallback' | 'none' =
      depsSection.trim() ? 'dependencies_section' : 'none';
    if (!depsSection.trim()) {
      const fallback = findBoldLabelDependencies(sections);
      if (fallback) {
        depsSection = fallback;
        source = 'bold_label_fallback';
      }
    }
    const deps = parseDependenciesSection(depsSection, parseRepoSlug());
    // Fallback yielded text but no refs → revert source to 'none'.
    if (source === 'bold_label_fallback' && deps.length === 0) source = 'none';

    return envelope({
      ok: true,
      issue_ref: args.issue_ref,
      dependencies: deps,
      count: deps.length,
      source,
    });
  },
};

export default specDependenciesHandler;
