/**
 * Shared spec parsing helpers for the `spec_*` tool cluster.
 *
 * An "issue spec" (or "work item spec") is a markdown body with
 * second-level headings (`## Heading`) that partition it into
 * sections. Wave 2 tools (`spec_validate_structure`,
 * `spec_acceptance_criteria`, `spec_dependencies`, `epic_sub_issues`)
 * reuse this module to avoid duplicating the section-parsing logic.
 *
 * Lives in `lib/` so the handler registry codegen (which scans
 * `handlers/*.ts`) ignores it.
 */

/**
 * Normalize a heading title into a snake_case section key:
 *   "Acceptance Criteria" -> "acceptance_criteria"
 *   "  Tests  "            -> "tests"
 */
export function normalizeHeading(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]+/g, '')
    .replace(/[\s-]+/g, '_');
}

export interface ParsedSections {
  sections: Record<string, string>;
  order: string[];
}

/**
 * Parse a markdown body into `## Heading` sections. Only top-level
 * H2 headings partition the body; H3 and deeper headings are part
 * of the content.
 */
export function parseSections(markdown: string): ParsedSections {
  const lines = markdown.split('\n');
  const sections: Record<string, string> = {};
  const order: string[] = [];
  let currentKey: string | null = null;
  let currentLines: string[] = [];

  const flush = () => {
    if (currentKey !== null) {
      sections[currentKey] = currentLines.join('\n').trim();
    }
  };

  for (const line of lines) {
    const h2 = /^##\s+(.*)$/.exec(line);
    if (h2) {
      flush();
      const key = normalizeHeading(h2[1]);
      currentKey = key;
      currentLines = [];
      if (!order.includes(key)) order.push(key);
      continue;
    }
    if (currentKey !== null) {
      currentLines.push(line);
    }
  }
  flush();

  return { sections, order };
}

/**
 * Resolve an issue_ref (`#N` or `org/repo#N`) into an (owner, repo, number)
 * triple. Returns `null` on parse failure.
 */
export interface IssueRef {
  owner: string | null;
  repo: string | null;
  number: number;
}

export function parseIssueRef(ref: string): IssueRef | null {
  const full = /^([^/\s]+)\/([^/\s#]+)#(\d+)$/.exec(ref);
  if (full) {
    return { owner: full[1], repo: full[2], number: parseInt(full[3], 10) };
  }
  const short = /^#?(\d+)$/.exec(ref);
  if (short) {
    return { owner: null, repo: null, number: parseInt(short[1], 10) };
  }
  return null;
}
