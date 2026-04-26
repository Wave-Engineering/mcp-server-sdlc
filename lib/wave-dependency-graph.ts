// Dependency-graph core — promoted out of `handlers/wave_dependency_graph.ts`
// during Story 2.9 (#303) so the handler can be a thin adapter-dispatching
// shell under the 80-line R-05 budget.
//
// This module is platform-agnostic: it consumes a caller-supplied
// `IssueFetcher` (reusing the contract from lib/wave-compute.ts) that resolves
// `{ body, title }` for an `IssueRef`. The adapter layer —
// `getAdapter().fetchIssue(...)` — lives behind that injection point, keeping
// all markdown parsing and graph topology logic out of the handler layer and
// out of subprocess-contaminated code.
//
// The dependency-parsing logic here is a near-duplicate of wave-compute's
// (`parseDependencies`). A future refactor could share — explicitly out of
// scope for Story 2.9 per the issue spec.

import { parseIssueRef, parseSections, type IssueRef } from './spec_parser';
import { buildGraph, computeWaves, type DepNode } from './dependency_graph';
import type { IssueFetcher } from './wave-compute';

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

export function parseDependencies(section: string, currentSlug: string | null): string[] {
  if (!section || /^none\b/i.test(section.trim())) return [];
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
    found.add(currentSlug ? `${currentSlug}#${m[1]}` : `#${m[1]}`);
  }
  return Array.from(found);
}

export async function resolveIssueList(
  issueRefs: string[] | undefined,
  epicRef: string | undefined,
  slug: string | null,
  fetchIssue: IssueFetcher,
): Promise<string[]> {
  if (issueRefs) return issueRefs.map(r => normalizeRef(r, slug));
  if (!epicRef) return [];
  const ref = parseIssueRef(epicRef);
  if (!ref) return [];
  const epic = await fetchIssue(ref);
  const sections = parseSections(epic.body).sections;
  const subSection =
    sections.sub_issues ?? sections.subissues ?? sections.children ?? sections.tasks ?? '';
  const refs: string[] = [];
  const re = /(?:^|\s)([^/\s#]+\/[^/\s#]+#\d+|https?:\/\/\S+\/issues\/\d+|#\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(subSection)) !== null) {
    refs.push(normalizeRef(m[1], slug));
  }
  const seen = new Set<string>();
  return refs.filter(r => !seen.has(r) && (seen.add(r), true));
}

/** Response envelope the handler wraps into `{content:[{text: JSON.stringify(...)}]}`. */
export type DependencyGraphResult =
  | {
      ok: true;
      nodes: ReturnType<typeof buildGraph>['nodes'];
      edges: ReturnType<typeof buildGraph>['edges'];
      reason?: string;
      fetched_count: number;
      warnings?: string[];
    }
  | {
      ok: false;
      error: string;
      issue_count?: number;
      fetched_count?: number;
    };

/**
 * Build the dependency graph for an explicit issue list OR an epic's sub-issues.
 *
 * Contract parity with the pre-migration handler (tests/wave_dependency_graph.test.ts):
 *   - empty refs → ok:true with empty nodes/edges.
 *   - per-sub fetch failure recorded in `failures[]`; if ALL fail → ok:false.
 *   - epic fetch failure throws → caller's outer try/catch surfaces ok:false.
 */
export async function computeDependencyGraph(
  issueRefs: string[] | undefined,
  epicRef: string | undefined,
  slug: string | null,
  fetchIssue: IssueFetcher,
): Promise<DependencyGraphResult> {
  const refs = await resolveIssueList(issueRefs, epicRef, slug, fetchIssue);
  if (refs.length === 0) {
    return { ok: true, nodes: [], edges: [], fetched_count: 0 };
  }

  const nodes: DepNode[] = [];
  const failures: string[] = [];
  let fetchedCount = 0;

  for (const ref of refs) {
    const parsed = parseIssueRef(ref);
    if (!parsed) continue;
    try {
      const data = await fetchIssue(parsed);
      const sections = parseSections(data.body).sections;
      // Use the sub-issue's own repo slug for its deps, not the epic's.
      const refSlug =
        parsed.owner && parsed.repo ? `${parsed.owner}/${parsed.repo}` : slug;
      nodes.push({
        ref,
        title: data.title,
        depends_on: parseDependencies(sections.dependencies ?? '', refSlug),
      });
      fetchedCount++;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      failures.push(`failed to fetch ${ref}: ${errorMsg}`);
    }
  }

  if (fetchedCount === 0 && refs.length > 0) {
    return {
      ok: false,
      error: `all ${refs.length} spec fetches failed: ${failures[0] ?? 'unknown error'}`,
      issue_count: refs.length,
      fetched_count: 0,
    };
  }

  const graph = buildGraph(nodes);
  const waveResult = computeWaves(nodes);
  const response: DependencyGraphResult = {
    ok: true,
    nodes: graph.nodes,
    edges: graph.edges,
    reason: waveResult.reason,
    fetched_count: fetchedCount,
  };
  if (failures.length > 0) {
    response.warnings = failures;
  }
  return response;
}

/** Re-export for convenience — handlers may want the `IssueRef` type. */
export type { IssueRef } from './spec_parser';
