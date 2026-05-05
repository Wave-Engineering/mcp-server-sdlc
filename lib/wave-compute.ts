// Wave-computation core — promoted out of `handlers/wave_compute.ts` during
// Story 2.8 (#302) so the handler can be a thin adapter-dispatching shell
// under the 80-line R-05 budget.
//
// This module is platform-agnostic: it consumes a caller-supplied
// `IssueFetcher` (see `fetchIssue` param) that resolves `{ body, title }` for
// an `IssueRef`. The adapter layer — `getAdapter().fetchIssue(...)` — lives
// behind that injection point, keeping all markdown parsing and wave-topology
// logic out of the handler layer and out of subprocess-contaminated code.
//
// Everything here is deterministic + unit-testable without mocking
// `child_process`. Upstream tests cover the aliasing + story-self fallback
// paths via the handler's own `tests/wave_compute.test.ts`; this module
// intentionally does not duplicate them.
//
// Mirrors REQUIRED_SECTION_ALIASES in handlers/spec_validate_structure.ts
// (lines 14-18). Kept in lockstep so the story-self fallback applies the same
// "valid spec" test that /prepwaves uses upstream.

import {
  findBoldLabelDependencies,
  findSubIssueSection,
  parseIssueRef,
  parseSections,
  type IssueRef,
} from './spec_parser';
import { computeWaves, type DepNode } from './dependency_graph';

export const REQUIRED_SECTION_ALIASES: Record<string, readonly string[]> = {
  changes: ['changes', 'implementation_steps'],
  tests: ['tests', 'test_procedures'],
  acceptance_criteria: ['acceptance_criteria'],
};

export interface SubIssue {
  ref: string;
  title?: string;
}

export interface FetchedIssue {
  body: string;
  title: string;
}

/** Async fetcher contract. Must throw on fetch failure. */
export type IssueFetcher = (ref: IssueRef) => Promise<FetchedIssue>;

export function normalizeRef(ref: string, currentSlug: string | null): string {
  const urlM =
    /https?:\/\/(?:github\.com|gitlab\.com)\/([^\s/]+)\/([^\s/]+)\/(?:-\/)?issues\/(\d+)/.exec(
      ref,
    );
  if (urlM) return `${urlM[1]}/${urlM[2]}#${urlM[3]}`;

  const crossM = /^([^/\s#]+)\/([^/\s#]+)#(\d+)$/.exec(ref);
  if (crossM) return ref;

  const shortM = /^#?(\d+)$/.exec(ref);
  if (shortM) return currentSlug ? `${currentSlug}#${shortM[1]}` : `#${shortM[1]}`;
  return ref;
}

export function parseTableSubIssues(
  section: string,
  currentSlug: string | null,
): SubIssue[] {
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
  const issueCol = headerCells.findIndex(c => c.includes('issue'));
  const titleCol = headerCells.findIndex(c => c.includes('title'));

  let startRow = headerIdx + 1;
  if (startRow < lines.length && /^\|[\s\-:|]+\|$/.test(lines[startRow])) startRow += 1;

  for (let i = startRow; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('|')) break;
    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    const getCell = (idx: number) => (idx >= 0 && idx < cells.length ? cells[idx] : '');
    const issueRaw = getCell(issueCol);
    if (!issueRaw) continue;
    subs.push({
      ref: normalizeRef(issueRaw, currentSlug),
      title: titleCol >= 0 ? getCell(titleCol) || undefined : undefined,
    });
  }
  return subs;
}

export function parseBulletSubIssues(
  section: string,
  currentSlug: string | null,
): SubIssue[] {
  const subs: SubIssue[] = [];
  const re = /^\s*[-*]\s*(?:\[[ xX]\]\s*)?([^\n]*)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(section)) !== null) {
    const text = m[1].trim();
    if (!text) continue;
    const refM =
      /(?:^|\s)([^/\s#]+\/[^/\s#]+#\d+|https?:\/\/\S+\/issues\/\d+|#\d+)/.exec(text);
    if (!refM) continue;
    const ref = normalizeRef(refM[1], currentSlug);
    const title = text.replace(refM[0], '').trim().replace(/^[-:*\s]+/, '').trim();
    subs.push({ ref, title: title || undefined });
  }
  return subs;
}

export function parseDependencies(
  section: string,
  currentSlug: string | null,
): string[] {
  if (!section) return [];
  if (/^none\b/i.test(section.trim())) return [];
  const found = new Set<string>();

  const urlRe =
    /https?:\/\/(?:github\.com|gitlab\.com)\/([^\s/]+)\/([^\s/]+)\/(?:-\/)?issues\/(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(section)) !== null) {
    found.add(`${m[1]}/${m[2]}#${m[3]}`);
  }
  const crossRe = /\b([^\s/#]+)\/([^\s/#]+)#(\d+)\b/g;
  while ((m = crossRe.exec(section)) !== null) {
    if (m[1].startsWith('http') || m[1].includes('.')) continue;
    found.add(`${m[1]}/${m[2]}#${m[3]}`);
  }
  const shortRe = /(?<![/\w])#(\d+)\b/g;
  while ((m = shortRe.exec(section)) !== null) {
    const normalized = currentSlug ? `${currentSlug}#${m[1]}` : `#${m[1]}`;
    found.add(normalized);
  }
  return Array.from(found);
}

/** Response envelope the handler wraps into `{content:[{text: JSON.stringify(...)}]}`. */
export type WaveComputeResult =
  | {
      ok: true;
      epic_ref: string;
      waves: ReturnType<typeof computeWaves>['waves'];
      topology: string;
      reason: string;
      total_issues: number;
      fetched_count: number;
      warnings?: string[];
      fallback_reason?: string;
    }
  | {
      ok: false;
      error: string;
      missing_sections?: string[];
      issue_count?: number;
      fetched_count?: number;
      waves?: ReturnType<typeof computeWaves>['waves'];
      total_issues?: number;
    };

/**
 * Compute dependency-ordered waves for an epic's sub-issues.
 *
 * - `epicRef`       caller's raw epic_ref string (for the response envelope)
 * - `ref`           parsed `IssueRef` of the epic (owner/repo/number)
 * - `slug`          `owner/repo` slug to resolve bare `#N` refs in the epic body
 * - `fetchIssue`    injected async fetcher (adapter-backed in the handler)
 *
 * Contract parity with the pre-migration handler (tests/wave_compute.test.ts):
 *   - epic fetch failure throws → caller's outer try/catch surfaces `ok:false`.
 *   - per-sub fetch failure recorded in `failures[]`; if ALL fail → ok:false.
 *   - no sub-issues + valid-spec epic → single-wave story-self fallback.
 *   - no sub-issues + invalid-spec epic → ok:false with `missing_sections`.
 */
export async function computeWavesForEpic(
  epicRef: string,
  ref: IssueRef,
  slug: string | null,
  fetchIssue: IssueFetcher,
): Promise<WaveComputeResult> {
  const epicData = await fetchIssue(ref);
  const epicSections = parseSections(epicData.body).sections;
  const subIssuesSection = findSubIssueSection(epicSections) ?? '';

  const subs = [
    ...parseTableSubIssues(subIssuesSection, slug),
    ...parseBulletSubIssues(subIssuesSection, slug),
  ];
  // Dedup by ref.
  const seen = new Set<string>();
  const dedupedSubs: SubIssue[] = [];
  for (const s of subs) {
    if (!seen.has(s.ref)) {
      seen.add(s.ref);
      dedupedSubs.push(s);
    }
  }

  // Story-self fallback: no sub-issues found → check whether the issue itself
  // is a valid spec. If so, treat as a single-issue single-wave plan. If not,
  // error loudly (do NOT silently return an empty plan).
  if (dedupedSubs.length === 0) {
    const presence: Record<string, boolean> = {};
    for (const [canonical, aliases] of Object.entries(REQUIRED_SECTION_ALIASES)) {
      presence[`has_${canonical}`] = aliases.some(
        alias => epicSections[alias] && epicSections[alias].trim().length > 0,
      );
    }
    const specValid =
      presence.has_changes && presence.has_tests && presence.has_acceptance_criteria;
    if (!specValid) {
      const missing = Object.entries(REQUIRED_SECTION_ALIASES)
        .filter(([canonical]) => !presence[`has_${canonical}`])
        .map(([canonical]) => canonical);
      return {
        ok: false,
        error: `no sub-issues found and epic spec is missing required sections: ${missing.join(', ')}`,
        missing_sections: missing,
      };
    }
    const selfRef = slug ? `${slug}#${ref.number}` : `#${ref.number}`;
    const selfNode: DepNode = {
      ref: selfRef,
      title: epicData.title,
      depends_on: [],
    };
    const selfResult = computeWaves([selfNode]);
    return {
      ok: true,
      epic_ref: epicRef,
      waves: selfResult.waves,
      topology: selfResult.topology,
      reason: selfResult.reason,
      total_issues: selfResult.total_issues,
      fetched_count: 1,
      fallback_reason: 'story-self',
    };
  }

  // Fetch dependencies for each sub-issue.
  const nodes: DepNode[] = [];
  const failures: string[] = [];
  let fetchedCount = 0;

  for (const sub of dedupedSubs) {
    const subRefParsed = parseIssueRef(sub.ref);
    if (!subRefParsed) continue;
    try {
      const subData = await fetchIssue(subRefParsed);
      const subSections = parseSections(subData.body).sections;
      // Use the sub-issue's own repo for resolving bare #N refs in ITS deps
      // section — a heterogeneous epic (sub-issue in a different repo) has
      // deps that live alongside the sub-issue, not the epic.
      const subSlug =
        subRefParsed.owner && subRefParsed.repo
          ? `${subRefParsed.owner}/${subRefParsed.repo}`
          : slug;
      // Mirror spec_dependencies: try ## Dependencies H2 first, then fall back
      // to **Dependencies:** bold-label across all sections if the H2 is absent
      // or empty. This keeps wave_compute and spec_dependencies in lockstep so
      // both tools accept the same dep sources (#288).
      let depsSection = subSections.dependencies ?? '';
      if (!depsSection.trim()) {
        const fallback = findBoldLabelDependencies(subSections);
        if (fallback) depsSection = fallback;
      }
      const deps = parseDependencies(depsSection, subSlug);
      nodes.push({
        ref: sub.ref,
        title: sub.title ?? subData.title,
        depends_on: deps,
      });
      fetchedCount++;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      failures.push(`failed to fetch ${sub.ref}: ${errorMsg}`);
    }
  }

  // If ALL fetches failed, return ok: false
  if (fetchedCount === 0 && dedupedSubs.length > 0) {
    return {
      ok: false,
      error: `all ${dedupedSubs.length} spec fetches failed: ${failures[0] ?? 'unknown error'}`,
      issue_count: dedupedSubs.length,
      fetched_count: 0,
    };
  }

  const result = computeWaves(nodes);
  if (result.error) {
    return {
      ok: false,
      error: result.error,
      waves: result.waves,
      total_issues: result.total_issues,
    };
  }

  const response: WaveComputeResult = {
    ok: true,
    epic_ref: epicRef,
    waves: result.waves,
    topology: result.topology,
    reason: result.reason,
    total_issues: result.total_issues,
    fetched_count: fetchedCount,
  };

  // Add warnings if SOME fetches failed
  if (failures.length > 0) {
    response.warnings = failures;
  }

  return response;
}
