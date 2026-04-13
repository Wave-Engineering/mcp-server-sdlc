/**
 * Shared file-overlap computation for flight_overlap (#37) and
 * flight_partition (#38). Lives in lib/ so the handler codegen ignores it.
 *
 * Extended in #169 to discount DEPENDENCY_MANIFEST overlaps — two issues
 * that only share manifest/lockfile paths are safe to run in the same
 * flight because those edits are commutative (adding different deps).
 */

// ---------------------------------------------------------------------------
// FileClass — mirrors commutativity-probe's classification
// ---------------------------------------------------------------------------

export type FileClass =
  | 'DEPENDENCY_MANIFEST'
  | 'CI_INFRA'
  | 'DATA_FORMAT'
  | 'ANALYZABLE'
  | 'OPAQUE';

/** Basename patterns that identify dependency manifests and their lockfiles. */
const MANIFEST_BASENAMES = new Set([
  'Cargo.toml',
  'Cargo.lock',
  'package.json',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'go.mod',
  'go.sum',
  'pyproject.toml',
  'poetry.lock',
  'requirements.txt',
  'Gemfile',
  'Gemfile.lock',
]);

/**
 * Classify a file path by its basename.  Only DEPENDENCY_MANIFEST is
 * positively identified; everything else returns `'ANALYZABLE'` (the
 * safe default that preserves existing serialization behavior).
 */
export function classifyFile(path: string): FileClass {
  const basename = path.split('/').pop() ?? path;
  return MANIFEST_BASENAMES.has(basename) ? 'DEPENDENCY_MANIFEST' : 'ANALYZABLE';
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Manifest {
  issue_ref: string;
  files_to_create?: string[];
  files_to_modify?: string[];
}

export type OverlapType = 'manifest_only' | 'source' | 'mixed';

export interface Conflict {
  a: string;
  b: string;
  files: string[];
  severity: 'hard';
  /** Classifies the overlap so callers can discount manifest-only conflicts. */
  overlap_type: OverlapType;
}

export function manifestFiles(m: Manifest): Set<string> {
  const files = new Set<string>();
  for (const f of m.files_to_create ?? []) files.add(f);
  for (const f of m.files_to_modify ?? []) files.add(f);
  return files;
}

// ---------------------------------------------------------------------------
// Overlap classification helper
// ---------------------------------------------------------------------------

function classifyOverlap(files: string[]): OverlapType {
  let hasManifest = false;
  let hasSource = false;
  for (const f of files) {
    if (classifyFile(f) === 'DEPENDENCY_MANIFEST') {
      hasManifest = true;
    } else {
      hasSource = true;
    }
  }
  if (hasManifest && hasSource) return 'mixed';
  if (hasManifest) return 'manifest_only';
  return 'source';
}

/**
 * Compute pairwise file conflicts. Any shared file path between two
 * manifests is a conflict. Each conflict is annotated with an
 * `overlap_type` so callers can discount manifest-only overlaps.
 */
export function computePairConflicts(manifests: Manifest[]): Conflict[] {
  const conflicts: Conflict[] = [];
  const fileSets = manifests.map(m => manifestFiles(m));
  for (let i = 0; i < manifests.length; i++) {
    for (let j = i + 1; j < manifests.length; j++) {
      const shared: string[] = [];
      for (const f of fileSets[i]) {
        if (fileSets[j].has(f)) shared.push(f);
      }
      if (shared.length > 0) {
        conflicts.push({
          a: manifests[i].issue_ref,
          b: manifests[j].issue_ref,
          files: shared,
          severity: 'hard',
          overlap_type: classifyOverlap(shared),
        });
      }
    }
  }
  return conflicts;
}

// ---------------------------------------------------------------------------
// Predicted verdict support
// ---------------------------------------------------------------------------

export interface PredictedVerdict {
  a: string;
  b: string;
  verdict: 'STRONG' | 'MEDIUM' | 'WEAK' | 'ORACLE_REQUIRED';
}

/**
 * Group issues into conflict-free sets greedily: for each issue, assign
 * it to the first group that has no conflict with any existing member.
 *
 * Manifest-only conflicts are discounted — two issues that only overlap
 * on DEPENDENCY_MANIFEST files (e.g. both add deps to package.json) are
 * allowed in the same group.  `commutativity_verify` at merge time
 * remains the safety net.
 *
 * When `predictedVerdicts` are provided, pairs with STRONG or MEDIUM
 * verdicts are also discounted even if they have source/mixed file
 * conflicts.  This enables smarter partitioning using planning-time
 * commutativity prediction.
 */
export function conflictFreeGroups(
  manifests: Manifest[],
  conflicts: Conflict[],
  predictedVerdicts?: PredictedVerdict[],
): string[][] {
  // Build a set of pairs that predicted verdicts say are safe.
  const safeByPrediction = new Set<string>();
  if (predictedVerdicts) {
    for (const pv of predictedVerdicts) {
      if (pv.verdict === 'STRONG' || pv.verdict === 'MEDIUM') {
        safeByPrediction.add(`${pv.a}|${pv.b}`);
        safeByPrediction.add(`${pv.b}|${pv.a}`);
      }
    }
  }

  // Only source and mixed conflicts block co-flight grouping,
  // unless a predicted verdict says the pair is safe.
  const blockingConflicts = conflicts.filter(c => {
    if (c.overlap_type === 'manifest_only') return false;
    if (safeByPrediction.has(`${c.a}|${c.b}`)) return false;
    return true;
  });

  const conflictSet = new Set<string>();
  for (const c of blockingConflicts) {
    // Store bidirectional edges.
    conflictSet.add(`${c.a}|${c.b}`);
    conflictSet.add(`${c.b}|${c.a}`);
  }

  const groups: string[][] = [];
  for (const m of manifests) {
    const ref = m.issue_ref;
    let placed = false;
    for (const group of groups) {
      const hasConflict = group.some(other => conflictSet.has(`${ref}|${other}`));
      if (!hasConflict) {
        group.push(ref);
        placed = true;
        break;
      }
    }
    if (!placed) groups.push([ref]);
  }
  return groups;
}
