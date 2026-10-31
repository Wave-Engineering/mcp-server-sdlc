// Entry conditions (ECs) and qualified cross-plan `depends_on` refs (#613).
//
// An entry condition is a named external precondition — another team's work, a
// platform change, a sign-off — that no story in the plan builds. A story that
// names a `start` EC does not start until that EC is `met`; a story that names a
// `delivery` EC may start, but its completion is held. ECs can go back
// (`met` → `reclosed`), so the gate is re-evaluated from the plan file on every
// call and never remembers an earlier `met`.
//
// EC state is recorded as append-only comments on the Plan issue:
//
//     [ec-state EC-3] met — https://example.com/evidence
//
// `wave_ec_sync` reads those comments and writes the latest state per EC into
// `phases-waves.json`; `wave_next_pending` reads it back. Everything in this
// module is pure: no platform calls, no file I/O.
//
// FAIL CLOSED. Every path that cannot prove an EC is `met` reads it as not met:
// a declared EC with no comment, a line whose status does not parse, a status
// value outside the enum, an EC a story names that the plan never declared, and
// a `gates` value outside the enum (read as `start`, the stricter gate). A
// qualified cross-plan ref is held unconditionally until a real cross-plan
// lookup exists — the one consumer has none today, and an unresolved ref must
// never read as satisfied.

export const EC_STATUSES = ['met', 'unmet', 'reclosed'] as const;
export type EcStatus = (typeof EC_STATUSES)[number];

export const EC_GATES = ['start', 'delivery'] as const;
export type EcGate = (typeof EC_GATES)[number];

/** One entry of the top-level `entry_conditions` map in `phases-waves.json`. */
export interface EntryCondition {
  status?: string;
  gates?: string;
  evidence?: string;
  updated_at?: string;
}

export type EntryConditions = Record<string, EntryCondition>;

/** A Plan-issue comment, as the `issueComments` adapter returns it. */
export interface EcComment {
  body: string;
  created_at: string;
  url?: string;
}

/** The latest parsed state for one EC. */
export interface EcStateRecord {
  status: EcStatus;
  evidence: string;
  updated_at: string;
}

/** An `[ec-state …]` line that could not be read. */
export interface MalformedEcLine {
  line: string;
  created_at: string;
  url?: string;
  reason: string;
}

export interface EcParseResult {
  latest: Record<string, EcStateRecord>;
  malformed: MalformedEcLine[];
}

// `[ec-state EC-3] met <evidence>`. The id is case-insensitive and normalized
// to `EC-<n>`; the status token is everything up to the first space.
const EC_LINE = /^\[ec-state\s+(ec-\d+)\]\s*(\S*)\s*(.*)$/i;
const EC_PREFIX = /^\[ec-state\b/i;
// Leading punctuation authors put between the status and the evidence.
const EVIDENCE_LEAD = /^[\s—–:|-]+/;

function normalizeEcId(raw: string): string {
  return `EC-${raw.slice(3)}`;
}

function isEcStatus(s: string): s is EcStatus {
  return (EC_STATUSES as readonly string[]).includes(s);
}

/**
 * Read every `[ec-state EC-n] <status>` line in `comments` and keep the latest
 * state per EC. Comments are ordered by `created_at` (stable, so same-instant
 * comments keep their input order) and later lines in one comment win over
 * earlier ones.
 *
 * A line whose EC id parses but whose status does not is reported in
 * `malformed` AND records that EC as `unmet`. It is not skipped: skipping it
 * would let a stale earlier `met` stand behind a garbled update. A line that
 * starts `[ec-state` but has no readable EC id is reported and otherwise
 * ignored, since there is no EC to attach it to.
 */
export function parseEcStateComments(comments: EcComment[]): EcParseResult {
  const ordered = comments
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      const ta = Date.parse(a.c.created_at);
      const tb = Date.parse(b.c.created_at);
      const da = Number.isNaN(ta) ? 0 : ta;
      const db = Number.isNaN(tb) ? 0 : tb;
      return da - db || a.i - b.i;
    })
    .map(({ c }) => c);

  const latest: Record<string, EcStateRecord> = {};
  const malformed: MalformedEcLine[] = [];

  for (const comment of ordered) {
    for (const rawLine of (comment.body ?? '').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!EC_PREFIX.test(line)) continue;
      const m = EC_LINE.exec(line);
      if (!m) {
        malformed.push({
          line,
          created_at: comment.created_at,
          url: comment.url,
          reason: 'no EC id: expected `[ec-state EC-<n>] met|unmet|reclosed`',
        });
        continue;
      }
      const id = normalizeEcId(m[1]);
      const token = m[2].toLowerCase();
      const evidence = m[3].replace(EVIDENCE_LEAD, '').trim() || comment.url || '';
      if (!isEcStatus(token)) {
        malformed.push({
          line,
          created_at: comment.created_at,
          url: comment.url,
          reason: `unknown status ${JSON.stringify(m[2])} for ${id}; read as unmet`,
        });
        latest[id] = { status: 'unmet', evidence, updated_at: comment.created_at };
        continue;
      }
      latest[id] = { status: token, evidence, updated_at: comment.created_at };
    }
  }

  return { latest, malformed };
}

/** What `syncEntryConditions` changed, for the caller's report. */
export interface EcSyncReport {
  entry_conditions: EntryConditions;
  /** ECs whose stored status differs from before the sync. */
  changed: Array<{ ec: string; from: string | null; to: EcStatus }>;
  /** Declared ECs with no `[ec-state]` comment at all; recorded as `unmet`. */
  no_comment: string[];
  /** EC ids that appear in comments but the plan does not declare. */
  undeclared_in_comments: string[];
}

/**
 * Merge parsed comment state into the plan's declared `entry_conditions`.
 *
 * Only declared ECs are written: an EC seen in comments but not declared has no
 * `gates`, so there is nothing to gate on, and inventing one would be guessing.
 * It is reported instead. A declared EC with no comment is written `unmet`.
 * `gates` is carried over from the declaration; an absent or unknown value is
 * written as `start`, the stricter gate.
 */
export function syncEntryConditions(
  declared: EntryConditions | undefined,
  parsed: EcParseResult,
): EcSyncReport {
  const out: EntryConditions = {};
  const changed: EcSyncReport['changed'] = [];
  const noComment: string[] = [];

  for (const [id, prev] of Object.entries(declared ?? {})) {
    const gates: EcGate = prev.gates === 'delivery' ? 'delivery' : 'start';
    const rec = parsed.latest[id];
    const next: EntryCondition = rec
      ? { status: rec.status, gates, evidence: rec.evidence, updated_at: rec.updated_at }
      : { status: 'unmet', gates, evidence: '', updated_at: prev.updated_at ?? '' };
    if (!rec) noComment.push(id);
    const from = typeof prev.status === 'string' ? prev.status : null;
    if (from !== next.status) changed.push({ ec: id, from, to: next.status as EcStatus });
    out[id] = next;
  }

  const undeclared = Object.keys(parsed.latest).filter((id) => !(id in (declared ?? {})));
  return {
    entry_conditions: out,
    changed,
    no_comment: noComment.sort(),
    undeclared_in_comments: undeclared.sort(),
  };
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * A qualified cross-plan ref is `<plan-id>#<issue>`: a non-empty prefix with no
 * `/`. The two shapes `depends_on` already carries are `#N` (empty prefix) and
 * `owner/repo#N` (a slash), so neither collides.
 */
const CROSS_PLAN_REF = /^([^/#\s]+)#(\d+)$/;

export function isCrossPlanRef(ref: unknown): ref is string {
  return typeof ref === 'string' && CROSS_PLAN_REF.test(ref.trim());
}

/** The per-issue fields the gate reads. */
export interface GatedIssue {
  number: number;
  ec?: unknown;
  depends_on?: unknown;
}

/** One EC that holds part of a wave. */
export interface EcHold {
  ec: string;
  /** The stored status, or `undeclared` when the plan has no entry for it. */
  status: string;
  gates: EcGate;
  issues: number[];
}

/** One cross-plan ref that holds a wave. */
export interface DepHold {
  ref: string;
  issue: number;
  reason: 'cross_plan_unresolved';
}

export interface WaveGate {
  /** ECs that stop the wave from starting. */
  start: EcHold[];
  /** ECs that let the wave start but hold its completion. */
  delivery: EcHold[];
  /** Cross-plan refs that stop the wave from starting. */
  depends_on: DepHold[];
  /** True when the wave must not start. */
  held: boolean;
}

function ecList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((e): e is string => typeof e === 'string' && e.length > 0);
}

/**
 * Evaluate the gate for one wave. A wave is held if ANY of its issues names a
 * `start` EC that is not `met`, or a cross-plan ref (#613 answer B: the whole
 * wave is held; splitting a stalled wave is the plan author's call at
 * /prepwaves, not the tool's).
 */
export function evaluateWaveGate(
  entryConditions: EntryConditions | undefined,
  issues: GatedIssue[],
): WaveGate {
  const start = new Map<string, EcHold>();
  const delivery = new Map<string, EcHold>();
  const deps: DepHold[] = [];

  for (const issue of issues) {
    for (const id of ecList(issue.ec)) {
      const cond = entryConditions?.[id];
      const status = cond === undefined ? 'undeclared' : String(cond.status ?? 'unmet');
      if (status === 'met') continue;
      // An undeclared EC has no known gate, so it takes the stricter one.
      const gates: EcGate = cond?.gates === 'delivery' ? 'delivery' : 'start';
      const bucket = gates === 'delivery' ? delivery : start;
      const hold = bucket.get(id) ?? { ec: id, status, gates, issues: [] };
      if (!hold.issues.includes(issue.number)) hold.issues.push(issue.number);
      bucket.set(id, hold);
    }
    if (Array.isArray(issue.depends_on)) {
      for (const ref of issue.depends_on) {
        if (isCrossPlanRef(ref)) {
          deps.push({ ref: ref.trim(), issue: issue.number, reason: 'cross_plan_unresolved' });
        }
      }
    }
  }

  const byId = (a: EcHold, b: EcHold) => a.ec.localeCompare(b.ec, 'en', { numeric: true });
  const startHolds = [...start.values()].sort(byId);
  return {
    start: startHolds,
    delivery: [...delivery.values()].sort(byId),
    depends_on: deps,
    held: startHolds.length > 0 || deps.length > 0,
  };
}

/** A one-line reason naming every hold, for the refusal's `error`. */
export function describeHolds(waveId: string, gate: WaveGate): string {
  const parts = [
    ...gate.start.map(
      (h) => `${h.ec} is ${h.status} (${h.gates}) for ${h.issues.map((n) => `#${n}`).join(', ')}`,
    ),
    ...gate.depends_on.map(
      (d) => `#${d.issue} depends on ${d.ref}, a cross-plan ref that cannot be resolved yet`,
    ),
  ];
  return `wave ${waveId} is held: ${parts.join('; ')}`;
}
