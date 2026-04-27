// Topology-classification core — promoted out of `handlers/wave_topology.ts`
// during Story 2.10 (#304) so the handler can be a thin adapter-dispatching
// shell under the 80-line R-05 budget. Mirrors the shape of
// `lib/wave-dependency-graph.ts` (Story 2.9, #303) and reuses its
// markdown-parsing helpers (`normalizeRef`, `parseDependencies`,
// `resolveIssueList`) to stay DRY.
//
// Platform-agnostic: consumes a caller-supplied `IssueFetcher` (reusing the
// contract from lib/wave-compute.ts). The adapter layer —
// `getAdapter().fetchIssue(...)` — lives behind that injection point, keeping
// all markdown parsing and topology logic out of the handler layer and out
// of subprocess-contaminated code.

import { parseIssueRef } from './spec_parser';
import { parseSections } from './spec_parser';
import { computeWaves, type DepNode } from './dependency_graph';
import {
  parseDependencies,
  resolveIssueList,
} from './wave-dependency-graph';
import type { IssueFetcher } from './wave-compute';

/** Response envelope the handler wraps into `{content:[{text: JSON.stringify(...)}]}`. */
export type TopologyResult =
  | {
      ok: true;
      topology: string;
      reason: string;
      wave_count: number;
      max_parallelism: number;
      issue_count: number;
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
 * Classify the topology of an explicit issue list OR an epic's sub-issues.
 *
 * Contract parity with the pre-migration handler (tests/wave_topology.test.ts):
 *   - empty refs → ok:true serial/0-waves sentinel.
 *   - per-sub fetch failure recorded in `failures[]`; if ALL fail → ok:false.
 *   - epic fetch failure throws → caller's outer try/catch surfaces ok:false.
 */
export async function computeTopology(
  issueRefs: string[] | undefined,
  epicRef: string | undefined,
  slug: string | null,
  fetchIssue: IssueFetcher,
): Promise<TopologyResult> {
  const refs = await resolveIssueList(issueRefs, epicRef, slug, fetchIssue);
  if (refs.length === 0) {
    return {
      ok: true,
      topology: 'serial',
      reason: 'no issues',
      wave_count: 0,
      max_parallelism: 0,
      issue_count: 0,
      fetched_count: 0,
    };
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

  const result = computeWaves(nodes);
  if (result.error) {
    return { ok: false, error: result.error };
  }

  const maxParallelism = result.waves.reduce(
    (max, w) => Math.max(max, w.issues.length),
    0,
  );

  const response: TopologyResult = {
    ok: true,
    topology: result.topology,
    reason: result.reason,
    wave_count: result.waves.length,
    max_parallelism: maxParallelism,
    issue_count: refs.length,
    fetched_count: fetchedCount,
  };
  if (failures.length > 0) {
    response.warnings = failures;
  }
  return response;
}
