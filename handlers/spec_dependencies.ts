import { execSync } from 'child_process';
import { z } from 'zod';
import type { HandlerDef } from '../types.js';
import { findBoldLabelDependencies, parseIssueRef, parseSections, type IssueRef } from '../lib/spec_parser';
import { detectPlatformForRef } from '../lib/shared/detect-platform.js';
import { parseRepoSlug } from '../lib/shared/parse-repo-slug.js';
import { gitlabApiIssue } from '../lib/glab.js';

const inputSchema = z.object({
  issue_ref: z.string().min(1, 'issue_ref must be a non-empty string'),
});

interface Dependency {
  ref: string;
  kind: 'blocks' | 'none';
}

function fetchBody(ref: IssueRef): string {
  const platform = detectPlatformForRef(ref);
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
 * Parse a Dependencies section and extract issue references in any
 * of these formats:
 *   #123
 *   org/repo#123
 *   https://github.com/org/repo/issues/123
 *   https://gitlab.com/org/repo/-/issues/123
 *
 * Normalized to `org/repo#N`. If a `#N` ref is seen, use the current
 * repo slug. "None" or empty content returns an empty list.
 */
function parseDependenciesSection(section: string, currentSlug: string | null): Dependency[] {
  if (!section) return [];
  const trimmed = section.trim();
  if (/^none\b/i.test(trimmed) || trimmed.length === 0) return [];

  const found = new Set<string>();
  const deps: Dependency[] = [];

  const urlRe =
    /https?:\/\/(?:github\.com|gitlab\.com)\/([^\s/]+)\/([^\s/]+)\/(?:-\/)?issues\/(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(section)) !== null) {
    const ref = `${m[1]}/${m[2]}#${m[3]}`;
    if (!found.has(ref)) {
      found.add(ref);
      deps.push({ ref, kind: 'blocks' });
    }
  }

  const crossRe = /\b([^\s/#]+)\/([^\s/#]+)#(\d+)\b/g;
  while ((m = crossRe.exec(section)) !== null) {
    // Skip if this text is inside a URL we already consumed.
    const candidate = `${m[1]}/${m[2]}#${m[3]}`;
    if (m[1].startsWith('http') || m[1].includes('.')) continue;
    if (!found.has(candidate)) {
      found.add(candidate);
      deps.push({ ref: candidate, kind: 'blocks' });
    }
  }

  // Short #N — only match at word boundary not preceded by a /.
  const shortRe = /(?<![/\w])#(\d+)\b/g;
  while ((m = shortRe.exec(section)) !== null) {
    const num = m[1];
    const ref = currentSlug ? `${currentSlug}#${num}` : `#${num}`;
    if (!found.has(ref)) {
      found.add(ref);
      deps.push({ ref, kind: 'blocks' });
    }
  }

  return deps;
}

// findBoldLabelDependencies lives in lib/spec_parser so spec_validate_structure
// can apply the same fallback rule. See SUB_ISSUE_SECTION_KEYS / lib comment.

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
      // If the fallback yielded text but no refs, the bold label didn't
      // actually provide dependency data — report source as 'none' rather
      // than misleading the caller about where (non-existent) refs came from.
      if (source === 'bold_label_fallback' && deps.length === 0) {
        source = 'none';
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              issue_ref: args.issue_ref,
              dependencies: deps,
              count: deps.length,
              source,
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

export default specDependenciesHandler;
