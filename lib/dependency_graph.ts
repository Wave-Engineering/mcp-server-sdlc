/**
 * Shared dependency-graph helpers for the wave_compute / wave_topology /
 * wave_dependency_graph handlers.
 *
 * Lives in `lib/` so the handler registry codegen ignores it.
 */

export interface DepNode {
  ref: string;
  title?: string;
  depends_on: string[]; // refs of prerequisites
}

export interface WavePartition {
  id: string;
  issues: DepNode[];
}

export interface ComputeResult {
  waves: WavePartition[];
  topology: 'serial' | 'parallel' | 'mixed';
  reason:
    | 'no issues'
    | 'single issue (trivial)'
    | 'no dependencies'
    | 'dependency chain forces ordering'
    | 'mixed parallelism and serial chains'
    | 'circular dependency detected';
  total_issues: number;
  error?: string;
}

/**
 * Partition nodes into waves via dependency-order Kahn's algorithm.
 * Each wave is a set of nodes whose remaining in-degree is zero
 * after previous waves have been removed.
 */
export function computeWaves(nodes: DepNode[]): ComputeResult {
  const byRef = new Map<string, DepNode>();
  for (const n of nodes) byRef.set(n.ref, n);

  // Sanitize deps: drop any dependency not in the node set (out-of-scope).
  const remaining = new Map<string, Set<string>>();
  for (const n of nodes) {
    const deps = new Set<string>();
    for (const d of n.depends_on) {
      if (byRef.has(d)) deps.add(d);
    }
    remaining.set(n.ref, deps);
  }

  const waves: WavePartition[] = [];
  const resolved = new Set<string>();
  let waveIdx = 1;

  while (resolved.size < nodes.length) {
    const currentWave: DepNode[] = [];
    for (const n of nodes) {
      if (resolved.has(n.ref)) continue;
      const deps = remaining.get(n.ref) ?? new Set();
      let ready = true;
      for (const d of deps) {
        if (!resolved.has(d)) {
          ready = false;
          break;
        }
      }
      if (ready) currentWave.push(n);
    }
    if (currentWave.length === 0) {
      // Cycle detected — remaining nodes all have unresolved deps.
      const remainingRefs = nodes
        .filter(n => !resolved.has(n.ref))
        .map(n => n.ref);
      return {
        waves,
        topology: 'serial',
        reason: 'circular dependency detected',
        total_issues: nodes.length,
        error: `circular dependency detected among: ${remainingRefs.join(', ')}`,
      };
    }
    waves.push({
      id: `wave-${waveIdx}`,
      issues: currentWave,
    });
    for (const n of currentWave) resolved.add(n.ref);
    waveIdx += 1;
  }

  const hasParallel = waves.some(w => w.issues.length > 1);
  const hasSerial = waves.some(w => w.issues.length === 1);
  let topology: 'serial' | 'parallel' | 'mixed';
  let reason: ComputeResult['reason'];

  if (nodes.length === 0) {
    topology = 'serial';
    reason = 'no issues';
  } else if (nodes.length === 1) {
    topology = 'serial';
    reason = 'single issue (trivial)';
  } else if (hasParallel && hasSerial) {
    topology = 'mixed';
    reason = 'mixed parallelism and serial chains';
  } else if (hasParallel) {
    topology = 'parallel';
    reason = 'no dependencies';
  } else {
    topology = 'serial';
    reason = 'dependency chain forces ordering';
  }

  return {
    waves,
    topology,
    reason,
    total_issues: nodes.length,
  };
}

/**
 * Build a nodes + edges representation for visualization.
 */
export interface GraphEdge {
  from: string;
  to: string;
  kind: 'blocks';
}

export function buildGraph(nodes: DepNode[]): { nodes: Array<{ ref: string; title?: string }>; edges: GraphEdge[] } {
  const edges: GraphEdge[] = [];
  const refSet = new Set(nodes.map(n => n.ref));
  for (const n of nodes) {
    for (const d of n.depends_on) {
      if (refSet.has(d)) {
        edges.push({ from: d, to: n.ref, kind: 'blocks' });
      }
    }
  }
  return {
    nodes: nodes.map(n => ({ ref: n.ref, title: n.title })),
    edges,
  };
}
