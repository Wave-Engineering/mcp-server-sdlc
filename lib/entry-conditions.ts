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
  author?: string;
  /**
   * True when the adapter proved the author can write to the repo. Anything
   * else (false, or absent) is untrusted: its `[ec-state]` lines are reported
   * and never applied, so a drive-by comment on a public Plan issue cannot
   * release a gate, nor hold one.
   */
  trusted?: boolean;
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

/** An `[ec-state …]` line from an author who could not be shown to have write access. */
export interface UntrustedEcLine {
  line: string;
  author: string | null;
  created_at: string;
  url?: string;
}

export interface EcParseResult {
  latest: Record<string, EcStateRecord>;
  malformed: MalformedEcLine[];
  untrusted: UntrustedEcLine[];
}

// `[ec-state EC-3] met <evidence>`. The id is case-insensitive and normalized
// to `EC-<n>`; `EC3`, `EC 3` and `EC-3 ` read as `EC-3` too, since a typo'd id
// that fails to parse is a garbled update. The status token is everything up
// to the first space.
const EC_LINE = /^\[ec-state\s+ec\s*-?\s*<?\s*(\d+)\s*>?\s*\]\s*(\S*)\s*(.*)$/i;
const EC_PREFIX = /^\[ec-state\b/i;
// The format itself, as hold messages and docs quote it (`EC-<n>`, `EC-n`):
// reported, never read as a state update about any EC. A bracketed slot with a
// digit in it (`EC-<3>`) is a filled-in id, not the template.
const EC_TEMPLATE = /^\[ec-state\s+ec\s*-?\s*(?:<[^>\]\d]*>|n)\s*\]/i;
// An id as a plan or a story may spell it: `EC-1`, `EC-01`, `ec1`, `EC <1>`.
const EC_ID = /^ec\s*-?\s*<?\s*(\d+)\s*>?$/i;
// Markdown an author may wrap a state line in: a list marker (bulleted or
// numbered), then emphasis or a code span. Only wrapper characters may come
// before `[ec-state`, so a sentence that mentions a state line is not one. A
// `>` quote is deliberately NOT stripped: quoting a state line is not posting it.
const MD_LEAD = /^(?:\d+[.)]\s+|[-*+]\s+)?[*_`]*/;
const MD_TRAIL = /[*_`]+\s*$/;
// The same wrappers less the code span, for the state-comment test below.
const EMPH_LEAD = /^(?:\d+[.)]\s+|[-*+]\s+)?[*_]*/;
const EMPH_TRAIL = /[*_]+\s*$/;
// Emphasis or a code span closing right after the status word: `**[ec-state EC-1] met** — <url>`.
const STATUS_WRAP = /[*_`]/g;
// Leading punctuation authors put between the status and the evidence.
const EVIDENCE_LEAD = /^[\s—–:|*_`-]+/;

function normalizeEcId(digits: string): string {
  // `EC-01` is `EC-1`: ids are matched exactly, so a padded id would miss its EC.
  return `EC-${digits.replace(/^0+(?=\d)/, '')}`;
}

/**
 * A state comment is one whose every non-blank line is a bare state line: no
 * prose, no code span or block, no quote, no indented block. Only a state
 * comment can release a gate. Any other comment that carries a `met` line is
 * more likely an instruction ("when it ships, post `[ec-state EC-1] met`")
 * than a report, and markdown has too many ways to quote a line for a parser to
 * tell them apart one wrapper at a time. Tightening lines need no such test: a
 * misread `unmet` or `reclosed` can only hold a wave.
 */
function isStateComment(lines: string[]): boolean {
  const nonBlank = lines.filter((l) => l.trim() !== '');
  return (
    nonBlank.length > 0 &&
    nonBlank.every(
      (l) =>
        !/^(?:\t| {4})/.test(l) &&
        !/[`~]/.test(l) &&
        EC_LINE.test(l.trim().replace(EMPH_LEAD, '').replace(EMPH_TRAIL, '').trim()),
    )
  );
}

/**
 * The canonical `EC-<n>` form of an EC id as a plan or story spells it, so a
 * declared `EC-01` and a posted `[ec-state EC-1]` meet. An id with no number
 * in it is returned unchanged, and so matches only itself.
 */
export function canonicalEcId(raw: string): string {
  const m = EC_ID.exec(raw.trim());
  return m ? normalizeEcId(m[1]) : raw;
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
 * starts `[ec-state` but has no readable EC id is reported, and since it could
 * be about any EC, every EC `met` before it reads as `unmet` until a later
 * well-formed line says otherwise. Ignoring it would let an earlier `met` stand
 * behind an unreadable `reclosed`.
 *
 * A comment that is not `trusted` contributes nothing: each of its
 * `[ec-state` lines is reported in `untrusted` and skipped. Skipping (not
 * reading as `unmet`) is deliberate: an untrusted `unmet` would let anyone
 * hold a wave.
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
  const untrusted: UntrustedEcLine[] = [];

  for (const comment of ordered) {
    const lines = (comment.body ?? '').split(/\r?\n/);
    const stateComment = isStateComment(lines);
    for (const rawLine of lines) {
      const line = rawLine.trim().replace(MD_LEAD, '').replace(MD_TRAIL, '').trim();
      if (!EC_PREFIX.test(line)) continue;
      if (comment.trusted !== true) {
        untrusted.push({
          line,
          author: comment.author ?? null,
          created_at: comment.created_at,
          url: comment.url,
        });
        continue;
      }
      if (EC_TEMPLATE.test(line)) {
        malformed.push({
          line,
          created_at: comment.created_at,
          url: comment.url,
          reason: 'the format template, not a state update; ignored',
        });
        continue;
      }
      const m = EC_LINE.exec(line);
      if (!m) {
        malformed.push({
          line,
          created_at: comment.created_at,
          url: comment.url,
          reason: 'no EC id: expected `[ec-state EC-<n>] met|unmet|reclosed`; every EC met before it reads as unmet',
        });
        for (const [id, rec] of Object.entries(latest)) {
          if (rec.status === 'met') {
            latest[id] = { status: 'unmet', evidence: comment.url ?? line, updated_at: comment.created_at };
          }
        }
        continue;
      }
      const id = normalizeEcId(m[1]);
      const token = m[2].replace(STATUS_WRAP, '').toLowerCase();
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
      if (token === 'met' && !stateComment) {
        malformed.push({
          line,
          created_at: comment.created_at,
          url: comment.url,
          reason: `met for ${id} not applied: a met counts only in a comment of bare state lines, with no prose, code or quote`,
        });
        continue;
      }
      latest[id] = { status: token, evidence, updated_at: comment.created_at };
    }
  }

  return { latest, malformed, untrusted };
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
    const rec = parsed.latest[canonicalEcId(id)];
    const next: EntryCondition = rec
      ? { status: rec.status, gates, evidence: rec.evidence, updated_at: rec.updated_at }
      : { status: 'unmet', gates, evidence: '', updated_at: prev.updated_at ?? '' };
    if (!rec) noComment.push(id);
    const from = typeof prev.status === 'string' ? prev.status : null;
    if (from !== next.status) changed.push({ ec: id, from, to: next.status as EcStatus });
    out[id] = next;
  }

  const declaredCanon = new Set(Object.keys(declared ?? {}).map(canonicalEcId));
  const undeclared = Object.keys(parsed.latest).filter((id) => !declaredCanon.has(id));
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

/** One `depends_on` entry that holds a wave. */
export interface DepHold {
  /** The ref, or the JSON of a value that is not a readable ref. */
  ref: string;
  issue: number;
  reason: 'cross_plan_unresolved' | 'malformed';
}

/**
 * The `EcHold.ec` used for stories whose `ec` field is present but is not an
 * array of non-empty strings. Its `status` is `malformed` and it always gates
 * `start`: an `ec` the gate cannot read must never read as "names no EC".
 */
export const MALFORMED_EC = '(malformed ec)';

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

/**
 * The EC ids a story names, or `null` when its `ec` is present but unreadable.
 * Absent (`undefined` or `null`) and `[]` both mean "names no EC". A scalar, or
 * an array holding anything but non-empty strings, is unreadable: filtering out
 * the bad entries would quietly drop the gate they were meant to set.
 */
function ecList(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  if (!raw.every((e) => typeof e === 'string' && e.length > 0)) return null;
  return raw as string[];
}

/** A `depends_on` entry in a shape the wave tools already read. */
function isReadableDep(ref: unknown): boolean {
  return (typeof ref === 'string' && ref.trim().length > 0) || (typeof ref === 'number' && Number.isInteger(ref));
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
  // Story `ec` entries and declared keys may spell an id differently (`EC-01`, `EC-1`).
  const conds = new Map<string, EntryCondition>();
  for (const [key, cond] of Object.entries(entryConditions ?? {})) {
    // Two keys for one id (`EC-1` and `EC-01`) merge to the stricter of each
    // field, so neither key can open the gate, or soften it, alone.
    const k = canonicalEcId(key);
    const prev = conds.get(k);
    if (prev === undefined) {
      conds.set(k, cond);
      continue;
    }
    conds.set(k, {
      ...prev,
      status: prev.status === 'met' && cond.status === 'met' ? 'met' : prev.status !== 'met' ? prev.status : cond.status,
      gates: prev.gates === 'delivery' && cond.gates === 'delivery' ? 'delivery' : 'start',
    });
  }

  for (const issue of issues) {
    const ids = ecList(issue.ec);
    if (ids === null) {
      const hold = start.get(MALFORMED_EC) ?? { ec: MALFORMED_EC, status: 'malformed', gates: 'start', issues: [] };
      if (!hold.issues.includes(issue.number)) hold.issues.push(issue.number);
      start.set(MALFORMED_EC, hold);
    }
    for (const id of ids ?? []) {
      const cond = conds.get(canonicalEcId(id));
      const status = cond === undefined ? 'undeclared' : String(cond.status ?? 'unmet');
      if (status === 'met') continue;
      // An undeclared EC has no known gate, so it takes the stricter one.
      const gates: EcGate = cond?.gates === 'delivery' ? 'delivery' : 'start';
      const bucket = gates === 'delivery' ? delivery : start;
      const hold = bucket.get(id) ?? { ec: id, status, gates, issues: [] };
      if (!hold.issues.includes(issue.number)) hold.issues.push(issue.number);
      bucket.set(id, hold);
    }
    const rawDeps = issue.depends_on;
    if (rawDeps !== undefined && rawDeps !== null && !Array.isArray(rawDeps)) {
      // A scalar (`"612#4"`) would otherwise skip the cross-plan check entirely.
      deps.push({ ref: JSON.stringify(rawDeps), issue: issue.number, reason: 'malformed' });
    } else if (Array.isArray(rawDeps)) {
      for (const ref of rawDeps) {
        if (!isReadableDep(ref)) {
          deps.push({ ref: JSON.stringify(ref) ?? String(ref), issue: issue.number, reason: 'malformed' });
        } else if (isCrossPlanRef(ref)) {
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
  const refs = (ns: number[]) => ns.map((n) => `#${n}`).join(', ');
  const parts = [
    ...gate.start.map((h) =>
      h.ec === MALFORMED_EC
        ? `${refs(h.issues)}: \`ec\` is not an array of EC ids`
        : `${h.ec} is ${h.status} (${h.gates}) for ${refs(h.issues)}`,
    ),
    ...gate.depends_on.map((d) =>
      d.reason === 'malformed'
        ? `#${d.issue} has an unreadable depends_on entry ${d.ref}`
        : `#${d.issue} depends on ${d.ref}, a cross-plan ref that cannot be resolved yet`,
    ),
  ];
  return `wave ${waveId} is held: ${parts.join('; ')}`;
}
