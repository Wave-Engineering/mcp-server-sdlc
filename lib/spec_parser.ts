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
 * Resolve an issue_ref (`#N` or `path/to/repo#N`) into an (owner, repo, number)
 * triple. Returns `null` on parse failure.
 *
 * For nested GitLab groups (e.g. `org/sub/group/repo#42`), `owner` captures
 * everything before the last `/` and `repo` is the final segment. This keeps
 * `projectPath({ owner, repo })` producing the correct full slug.
 */
export interface IssueRef {
  owner: string | null;
  repo: string | null;
  number: number;
}

export function parseIssueRef(ref: string): IssueRef | null {
  // Qualified ref: owner/repo#N or org/sub/group/repo#N
  const full = /^(.+)\/([^/\s#]+)#(\d+)$/.exec(ref);
  if (full) {
    return { owner: full[1], repo: full[2], number: parseInt(full[3], 10) };
  }
  const short = /^#?(\d+)$/.exec(ref);
  if (short) {
    return { owner: null, repo: null, number: parseInt(short[1], 10) };
  }
  return null;
}

/**
 * Canonical list of normalized H2 heading keys an Epic body can use to
 * declare its sub-issues. Both `epic_sub_issues` and `wave_compute` consume
 * this so the two tools stay in lock-step about which section names parse.
 *
 *   - Explicit:        sub_issues, subissues, children, tasks, task_list
 *   - Wave-plan shape: waves, wave_map, phases, phased_implementation_plan,
 *                      implementation_plan, stories, backlog
 *
 * The wave-plan aliases let `/devspec upshift`-generated Epic bodies
 * (which group `#NN` refs under `### Wave N` H3 headings inside a
 * `## Waves` H2) parse without requiring a rename.
 */
export const SUB_ISSUE_SECTION_KEYS = [
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

/**
 * Return the first matching section body from the parsed sections record,
 * iterating in `SUB_ISSUE_SECTION_KEYS` order. Returns `null` when no key
 * matches — callers should treat that as "no sub-issues declared".
 */
export function findSubIssueSection(sections: Record<string, string>): string | null {
  for (const k of SUB_ISSUE_SECTION_KEYS) {
    if (sections[k]) return sections[k];
  }
  return null;
}

/**
 * Match a `**Dependencies:**` (or `**Dependencies**`) bold label inside any
 * section body, capturing its content up to the next bold label or end of
 * section.
 *
 * Used by both `spec_dependencies` (for ref extraction) and
 * `spec_validate_structure` (for presence detection) so the two tools agree
 * on what counts as "declared dependencies." Without this, an issue with
 * `**Dependencies:** #5, #6` inside `## Metadata` extracts refs via
 * `spec_dependencies` but reports `has_dependencies: false` from
 * `spec_validate_structure` — a real inconsistency users hit during the
 * KAHUNA Dev Spec /prepwaves flow (2026-04-24).
 *
 * The `\n##\s` lookahead alternative is inert when this regex runs against
 * `parseSections` output (H2 lines have already been stripped as section
 * keys). It's preserved for callers who feed in raw markdown.
 *
 * Prefer calling `findBoldLabelDependencies` over using the regex directly.
 */
export const BOLD_LABEL_DEPENDENCIES_REGEX =
  /\*\*Dependencies:?\*\*\s*(.+?)(?=\n\s*(?:[-*]\s+)?\*\*[A-Z][A-Za-z ]*:?\*\*|\n##\s|\n*$)/s;

/**
 * Return the content following the first `**Dependencies:**` label across
 * any section. Empty string when the label is absent or has no content.
 */
export function findBoldLabelDependencies(sections: Record<string, string>): string {
  for (const sec of Object.values(sections)) {
    const m = BOLD_LABEL_DEPENDENCIES_REGEX.exec(sec);
    if (m && m[1].trim()) return m[1].trim();
  }
  return '';
}

/**
 * Issue-spec body grammar: canonical section key → the accepted H2 heading
 * aliases (already `normalizeHeading`-normalized) that satisfy it. Shared by
 * `spec_validate_structure` (fetch-then-validate) and `work_item`
 * (validate-at-creation, warn-not-reject — #487) so the two agree on grammar.
 */
export const REQUIRED_BODY_SECTIONS: Record<string, readonly string[]> = {
  changes: ['changes', 'implementation_steps'],
  tests: ['tests', 'test_procedures'],
  acceptance_criteria: ['acceptance_criteria'],
};
export const OPTIONAL_BODY_SECTIONS: Record<string, readonly string[]> = {
  dependencies: ['dependencies'],
};

/**
 * Render normalized alias keys back into their `## Title Case` H2 form, e.g.
 * `['implementation_steps']` -> `['## Implementation Steps']`. Lets a caller
 * name which headings would have satisfied a missing section.
 */
export function acceptedHeadings(aliases: readonly string[]): string[] {
  return aliases.map((a) => `## ${a.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}`);
}

export interface BodyGrammar {
  /** `has_<key>` presence flags for every required + optional section. */
  presence: Record<string, boolean>;
  /** Canonical keys of required sections that are absent or empty. */
  missing_sections: string[];
  /** For each missing section, the `## Heading` forms that would satisfy it. */
  accepted_headings: Record<string, string[]>;
  /** True when no required section is missing. */
  valid: boolean;
}

/**
 * Validate an issue-spec markdown body against the required-section grammar.
 * Side-effect-free — it inspects the body string only, doing no fetch — so both
 * the fetch-then-validate path (`spec_validate_structure`) and the
 * validate-at-creation path (`work_item`, #487) share one implementation.
 */
export function validateBodyStructure(body: string): BodyGrammar {
  const { sections } = parseSections(body);
  const hasSection = (aliases: readonly string[]) =>
    aliases.some((a) => sections[a] && sections[a].trim().length > 0);

  const presence: Record<string, boolean> = {};
  const missing: string[] = [];
  const accepted: Record<string, string[]> = {};

  for (const [k, aliases] of Object.entries(REQUIRED_BODY_SECTIONS)) {
    const has = hasSection(aliases);
    presence[`has_${k}`] = has;
    if (!has) {
      missing.push(k);
      accepted[k] = acceptedHeadings(aliases);
    }
  }
  for (const [k, aliases] of Object.entries(OPTIONAL_BODY_SECTIONS)) {
    presence[`has_${k}`] = hasSection(aliases);
  }
  // Bold-label fallback for has_dependencies only (parity with spec_dependencies).
  if (!presence.has_dependencies && findBoldLabelDependencies(sections)) {
    presence.has_dependencies = true;
  }

  return {
    presence,
    missing_sections: missing,
    accepted_headings: accepted,
    valid: missing.length === 0,
  };
}

/**
 * A single parsed dependency ref extracted from a `## Dependencies` section
 * or `**Dependencies:**` bold-label body. `kind` currently only carries the
 * `blocks` relation — placeholder for future expansion.
 */
export interface Dependency {
  ref: string;
  kind: 'blocks' | 'none';
}

/**
 * Parse a Dependencies section and extract issue references in any of these
 * formats:
 *
 *   #123
 *   org/repo#123
 *   https://github.com/org/repo/issues/123
 *   https://gitlab.com/org/repo/-/issues/123
 *
 * Normalized to `org/repo#N`. If a `#N` ref is seen, use `currentSlug` as the
 * owning repo. "None" or empty content returns an empty list.
 *
 * Lives in `lib/` (not the handler) because `spec_dependencies` is
 * platform-agnostic after the Story 2.5 adapter migration — the parser is
 * shared-module material, same as `findBoldLabelDependencies`.
 */
export function parseDependenciesSection(
  section: string,
  currentSlug: string | null,
): Dependency[] {
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
    const candidate = `${m[1]}/${m[2]}#${m[3]}`;
    if (m[1].startsWith('http') || m[1].includes('.')) continue;
    if (!found.has(candidate)) {
      found.add(candidate);
      deps.push({ ref: candidate, kind: 'blocks' });
    }
  }

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
