// Platform-agnostic helpers for `handlers/wave_reconcile.ts` — computes the
// three sets (Expected / Actual / Deferred), derives Missing / Unexpected /
// Dependency-violations, and renders the canonical `[drift-halt]` comment body
// per Dev Spec §5.4.1. No subprocess work, no adapter calls — pure functions +
// filesystem reads of `.claude/status/*.json` via Bun's file API.
//
// Naming: `wave-reconcile.ts` (kebab-case) is intentional — matches the
// existing kebab-case convention for newer `lib/` helpers (e.g.
// `wave-topology.ts`, `wave-dependency-graph.ts`). The older sibling
// `wave_reconcile_mrs_plan.ts` is the MR-backfill helper for a different
// handler — see `handlers/wave_reconcile_mrs.ts` — and is untouched here.

import { join } from 'path';

export function projectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

export async function fileExists(path: string): Promise<boolean> {
  return await Bun.file(path).exists();
}

export async function readJson(path: string): Promise<unknown> {
  return await Bun.file(path).json();
}

export async function statusDir(root: string): Promise<string> {
  const sdlc = join(root, '.sdlc');
  if (await fileExists(sdlc)) return join(sdlc, 'waves');
  return join(root, '.claude', 'status');
}

// ---------------------------------------------------------------------------
// Plan / State types — a superset of `wave_reconcile_mrs_plan.ts` extended
// with the fields Category B reconciliation needs (`depends_on`, `plan_id`,
// `plan_issue`, phase `number`, wave `number`). Kept local rather than
// re-exported to avoid cross-module churn.
// ---------------------------------------------------------------------------

export interface PlanIssue {
  /** Numeric ID of the issue on the target platform. */
  number: number;
  /**
   * Declared dependencies as `owner/repo#N` refs OR bare `#N` / numeric IDs.
   * May be absent — per §5.4.1 absence is conservatively treated as "no
   * declared dependencies" (skip the dep-violation check for this issue).
   */
  depends_on?: Array<string | number>;
  title?: string;
  ref?: string;
}

export interface PlanWave {
  id: string;
  number?: number;
  issues?: PlanIssue[];
  /**
   * Alternative name for `issues` — some plans author `stories: []`. We read
   * whichever is present (preferring `issues` for fidelity with today's
   * plans, falling back to `stories` for the §5.4.3 field name).
   */
  stories?: PlanIssue[];
}

export interface PlanPhase {
  number?: number;
  name?: string;
  waves?: PlanWave[];
}

export interface PlanData {
  phases?: PlanPhase[];
  plan_id?: number;
  plan_issue?: string;
  repo?: string;
}

export interface WaveState {
  status?: string;
  mr_urls?: Record<string, string>;
}

export interface Deferral {
  wave?: string;
  description?: string;
  risk?: string;
  status?: string;
}

export interface StateData {
  current_wave?: string | null;
  waves?: Record<string, WaveState>;
  deferrals?: Deferral[];
  kahuna_branch?: string | null;
}

// ---------------------------------------------------------------------------
// Pure lookups
// ---------------------------------------------------------------------------

export function findWave(plan: PlanData, id: string): PlanWave | null {
  for (const phase of plan.phases ?? []) {
    for (const wave of phase.waves ?? []) {
      if (wave.id === id) return wave;
    }
  }
  return null;
}

export function findPhaseFor(plan: PlanData, waveId: string): PlanPhase | null {
  for (const phase of plan.phases ?? []) {
    for (const wave of phase.waves ?? []) {
      if (wave.id === waveId) return phase;
    }
  }
  return null;
}

/** Stories in a wave — prefers `issues` (today's shape), falls back to `stories` (§5.4.3 name). */
export function waveIssues(wave: PlanWave): PlanIssue[] {
  if (Array.isArray(wave.issues) && wave.issues.length > 0) return wave.issues;
  if (Array.isArray(wave.stories)) return wave.stories;
  return [];
}

/**
 * Extract deferred issue numbers scoped to a wave. Matches the same
 * `#N` convention used by `wave_previous_merged_plan.ts` — canonical
 * deferral descriptions embed the issue number as `#<N>` and only
 * `status === 'accepted'` deferrals count (pending = still under
 * discussion, not yet a legitimate drop).
 */
export function deferredIssueNumbers(state: StateData, waveId: string): Set<number> {
  const out = new Set<number>();
  for (const d of state.deferrals ?? []) {
    if (d.status !== 'accepted' || d.wave !== waveId) continue;
    for (const m of (d.description ?? '').matchAll(/(?<!\w)#(\d+)/g)) {
      out.add(parseInt(m[1], 10));
    }
  }
  return out;
}

/**
 * Pull a bare issue number out of a declared dependency. Accepts:
 *   - number           → returned as-is
 *   - "#123"           → 123
 *   - "owner/repo#123" → 123
 *   - "123"            → 123
 * Returns `null` if nothing parseable is found.
 */
export function parseDepIssueNumber(dep: string | number): number | null {
  if (typeof dep === 'number' && Number.isFinite(dep)) return dep;
  if (typeof dep !== 'string') return null;
  const m = /#(\d+)|^(\d+)$/.exec(dep);
  if (!m) return null;
  return parseInt(m[1] ?? m[2], 10);
}

/**
 * Match a PR's head branch against our `feature/<N>-*` convention and
 * return the issue number, or `null` if the branch doesn't match. Also
 * handles `fix/`, `chore/`, `doc/`, `bug/` singular prefixes per CLAUDE.md
 * branch-prefix convention.
 */
export function issueNumberFromBranch(head: string): number | null {
  const m = /^(?:feature|fix|chore|doc|bug)\/(\d+)-/.exec(head);
  return m ? parseInt(m[1], 10) : null;
}

// ---------------------------------------------------------------------------
// Set computation — Missing / Unexpected / Dependency violations
// ---------------------------------------------------------------------------

export interface DriftSets {
  expected: number[];
  actual: number[];
  deferred: number[];
  missing: number[];
  unexpected: number[];
  dependencyViolations: DependencyViolation[];
}

export interface DependencyViolation {
  /** Issue that merged before its declared dependencies resolved. */
  issue: number;
  /** The unresolved dependencies (issue numbers). */
  unmet: number[];
}

/**
 * Compute the three drift checks per §5.4.1.
 *
 * `previouslyMerged` — issues merged on kahuna BEFORE the current wave's
 * window (foundation waves + prior waves). Used for the dep-violation check:
 * a story's declared deps are resolved if ∈ (previouslyMerged ∪ actual) and
 * merged EARLIER in the topological order. For the "B merged before A in the
 * same wave" case we additionally check merge order within `actual` via the
 * caller's ordering — see handler for the wiring.
 *
 * This function takes the sets as inputs (no IO). Dep violations are computed
 * against the union of `previouslyMerged` and `actual` — if a dep isn't in
 * either, that's a violation. Intra-wave ordering (B before A) is handled by
 * the caller when it knows merge timestamps; this helper treats same-wave
 * deps as satisfied iff the dep is also in `actual`.
 */
export function computeDriftSets(args: {
  expected: Iterable<number>;
  actual: Iterable<number>;
  deferred: Iterable<number>;
  previouslyMerged?: Iterable<number>;
  issues: PlanIssue[];
  /**
   * Optional: merge order of issues in `actual`, oldest-first. When supplied,
   * a same-wave dep is satisfied only if it merged STRICTLY BEFORE the
   * dependent issue. When omitted, same-wave deps are considered satisfied
   * if they appear anywhere in `actual` (weaker check — used when merge
   * timestamps are unavailable, per the §5.4.1 failure envelope's
   * conservative posture).
   */
  actualMergeOrder?: number[];
  foundationWaveIssues?: Iterable<number>;
}): DriftSets {
  const expected = new Set(args.expected);
  const actual = new Set(args.actual);
  const deferred = new Set(args.deferred);
  const prev = new Set(args.previouslyMerged ?? []);
  const foundation = new Set(args.foundationWaveIssues ?? []);

  // Missing = Expected − Actual − Deferred
  const missing: number[] = [];
  for (const n of expected) {
    if (!actual.has(n) && !deferred.has(n)) missing.push(n);
  }

  // Unexpected = Actual − Expected
  // Deferrals don't affect Unexpected — a deferred-then-merged story is still
  // "unexpected" (it wasn't on the wave plan). Filter them out only if they
  // were explicitly deferred AND didn't actually merge.
  const unexpected: number[] = [];
  for (const n of actual) {
    if (!expected.has(n)) unexpected.push(n);
  }

  // Dependency violations
  const depViolations: DependencyViolation[] = [];
  const orderIndex = new Map<number, number>();
  if (args.actualMergeOrder) {
    for (let i = 0; i < args.actualMergeOrder.length; i++) {
      orderIndex.set(args.actualMergeOrder[i], i);
    }
  }
  for (const issue of args.issues) {
    // Skip foundation-wave stories (nothing precedes them) and issues that
    // aren't in `actual` (only merged stories can violate deps — missing
    // stories are already a "Missing" drift and don't double-count here).
    if (foundation.has(issue.number)) continue;
    if (!actual.has(issue.number)) continue;
    if (!Array.isArray(issue.depends_on) || issue.depends_on.length === 0) continue;

    const unmet: number[] = [];
    for (const depRaw of issue.depends_on) {
      const dep = parseDepIssueNumber(depRaw);
      if (dep === null) continue; // unparseable dep — conservatively skip
      // Dep is satisfied if:
      //   - it was merged in a previous wave (prev), OR
      //   - it merged in THIS wave AND strictly before our issue in the
      //     provided merge order. If no merge order was provided, fall back
      //     to "in actual" (still better than silent pass).
      if (prev.has(dep)) continue;
      if (actual.has(dep)) {
        if (args.actualMergeOrder) {
          const depIdx = orderIndex.get(dep);
          const issueIdx = orderIndex.get(issue.number);
          if (depIdx !== undefined && issueIdx !== undefined && depIdx < issueIdx) {
            continue; // dep merged before this issue in-wave → satisfied
          }
          unmet.push(dep);
        } else {
          continue; // no order info → treat as satisfied (§5.4.1 conservative)
        }
      } else {
        unmet.push(dep);
      }
    }
    if (unmet.length > 0) depViolations.push({ issue: issue.number, unmet });
  }

  return {
    expected: [...expected].sort((a, b) => a - b),
    actual: [...actual].sort((a, b) => a - b),
    deferred: [...deferred].sort((a, b) => a - b),
    missing: missing.sort((a, b) => a - b),
    unexpected: unexpected.sort((a, b) => a - b),
    dependencyViolations: depViolations.sort((a, b) => a.issue - b.issue),
  };
}

export function hasDrift(sets: DriftSets): boolean {
  return sets.missing.length > 0 ||
    sets.unexpected.length > 0 ||
    sets.dependencyViolations.length > 0;
}

// ---------------------------------------------------------------------------
// [drift-halt] comment rendering — matches §5.4.1 worked example verbatim.
// ---------------------------------------------------------------------------

function fmtIssueList(ns: number[]): string {
  if (ns.length === 0) return '(none)';
  return ns.map((n) => `#${n}`).join(' ');
}

function fmtDepViolations(vs: DependencyViolation[]): string {
  if (vs.length === 0) return '(none)';
  return vs
    .map((v) => `#${v.issue} (depends on ${v.unmet.map((n) => `#${n}`).join(', ')})`)
    .join('; ');
}

function fmtWaveLabel(phase: PlanPhase | null, wave: PlanWave | null, waveId: string): string {
  const phaseNum = phase?.number;
  const waveNum = wave?.number;
  if (typeof phaseNum === 'number' && typeof waveNum === 'number') {
    return `Phase ${phaseNum} Wave ${waveNum}`;
  }
  return waveId;
}

function fmtWaveSlug(phase: PlanPhase | null, wave: PlanWave | null, waveId: string): string {
  // `wave-5` style used in the §5.4.1 worked example. We re-use the flat
  // numeric wave index when available; otherwise fall back to the full wave
  // ID (e.g. `P2W3`).
  const waveNum = wave?.number;
  if (typeof waveNum === 'number') return `wave-${waveNum}`;
  return waveId;
}

export interface RenderDriftHaltArgs {
  timestamp: string; // ISO 8601 (e.g. `2026-04-27T14:55Z`)
  waveId: string;
  plan: PlanData;
  sets: DriftSets;
  /** Agent signature (Dev-Name + avatar + team) for the footer. */
  signature?: string;
  /** Bus artifacts directory reference for the Next-step line. */
  busArtifactsHint?: string;
}

/**
 * Produce the canonical `[drift-halt]` Category B comment body. The shape
 * matches Dev Spec §5.4.1's worked example VERBATIM — don't reformat fields
 * without updating the spec; the status-line grep patterns are load-bearing.
 */
export function renderDriftHaltComment(args: RenderDriftHaltArgs): string {
  const phase = findPhaseFor(args.plan, args.waveId);
  const wave = findWave(args.plan, args.waveId);
  const waveLabel = fmtWaveLabel(phase, wave, args.waveId);
  const waveSlug = fmtWaveSlug(phase, wave, args.waveId);
  const sig = args.signature ?? '— **rules-lawyer** 📜 (cc-workflow)';
  const busHint = args.busArtifactsHint ?? `/tmp/wavemachine/<repo>/${waveSlug}/flight-N/`;

  const lines = [
    `[drift-halt] ${args.timestamp} · /wavemachine ${waveSlug}`,
    `**Category:** B — Story count / dependency violation`,
    `**Wave:** ${waveLabel}`,
    `**Expected stories:** ${fmtIssueList(args.sets.expected)}`,
    `**Actual merged:** ${fmtIssueList(args.sets.actual)}`,
    `**Missing:** ${fmtIssueList(args.sets.missing)}`,
    `**Unexpected:** ${fmtIssueList(args.sets.unexpected)}`,
    `**Dependency violations:** ${fmtDepViolations(args.sets.dependencyViolations)}`,
    `**Deferrals recorded:** ${fmtIssueList(args.sets.deferred)}`,
    `**Next step:** Pair investigates. Flight report in bus artifacts at ${busHint}. Either close-as-deferred (\`wave_defer\` + resume), re-flight, or accept the plan's actual shape and update phases-waves.json.`,
    ``,
    sig,
  ];
  return lines.join('\n');
}
