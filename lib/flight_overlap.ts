/**
 * Shared file-overlap computation for flight_overlap (#37) and
 * flight_partition (#38). Lives in lib/ so the handler codegen ignores it.
 */

export interface Manifest {
  issue_ref: string;
  files_to_create?: string[];
  files_to_modify?: string[];
}

export interface Conflict {
  a: string;
  b: string;
  files: string[];
  severity: 'hard';
}

export function manifestFiles(m: Manifest): Set<string> {
  const files = new Set<string>();
  for (const f of m.files_to_create ?? []) files.add(f);
  for (const f of m.files_to_modify ?? []) files.add(f);
  return files;
}

/**
 * Compute pairwise file conflicts. Any shared file path between two
 * manifests is a hard conflict (symbol-level refinement is v2).
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
        });
      }
    }
  }
  return conflicts;
}

/**
 * Group issues into conflict-free sets greedily: for each issue, assign
 * it to the first group that has no conflict with any existing member.
 */
export function conflictFreeGroups(
  manifests: Manifest[],
  conflicts: Conflict[],
): string[][] {
  const conflictSet = new Set<string>();
  for (const c of conflicts) {
    // Store bidirectional edges.
    conflictSet.add(`${c.a}|${c.b}`);
    conflictSet.add(`${c.b}|${c.a}`);
  }

  const groups: string[][] = [];
  for (const m of manifests) {
    const ref = m.issue_ref;
    let placed = false;
    for (const group of groups) {
      const conflicts = group.some(other => conflictSet.has(`${ref}|${other}`));
      if (!conflicts) {
        group.push(ref);
        placed = true;
        break;
      }
    }
    if (!placed) groups.push([ref]);
  }
  return groups;
}
