// FlightDeck emit — TS mirror of cc's src/wave_status/events/emit.py (S1.4 / #862).
//
// The lowest-deterministic-layer emitter for the non-CLI sdlc handlers (S1.5).
// Every wired call routes through emit(), which:
//
//   1. builds + validates the event against the vendored S0.1 contract
//      (lib/flightdeck/schema.json — mirrored here as typed constants + a
//      hand-rolled validator; F-7: both sides validate the SAME schema, they do
//      NOT share code);
//   2. atomically appends it as one JSONL line to the durable local buffer
//      (~/.claude/status/events.jsonl by default) [R-01];
//   3. ships it non-blocking (fire-and-forget) to $FLIGHTDECK_INGEST_URL with
//      bearer-token auth, off the caller's control flow [R-02];
//   4. replays unsent buffered lines in order via an offset marker when the
//      ingest endpoint recovers [R-04].
//
// CONTRACT: emit() NEVER throws to a caller. It is instrumentation — a bug here
// must never break a handler. Every public entrypoint swallows all exceptions
// (R-03). This mirrors emit.py exactly (behavior, not code).
//
// DI-seams (env vars, identical to the Python emitter):
//   FLIGHTDECK_INGEST_URL    — POST target. UNSET ⇒ buffer-only, never ships.
//   FLIGHTDECK_INGEST_TOKEN  — bearer token for the Authorization header.
//   FLIGHTDECK_INGEST_TIMEOUT— POST timeout seconds (default 2).
//   FLIGHTDECK_EVENTS_PATH   — override the buffer file (test isolation).
//   FLIGHTDECK_EMIT_DISABLED — hard off switch (no-op emit).
//   FLIGHTDECK_ACTIVITY_ID / FLIGHTDECK_AGENT / FLIGHTDECK_LOG_REF — scope
//     defaults for emitStateEvent().

import { appendFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// The contract — kept in lockstep with lib/flightdeck/schema.json ($defs).
// flightdeck_emit.test.ts asserts these equal the schema enums (drift guard).
// ---------------------------------------------------------------------------

export const SCHEMA_VERSION = 1;

/** The eight deterministic event kinds. */
export const EVENT_KINDS = [
  'activity_start',
  'phase',
  'step',
  'metric',
  'concern',
  'blocked_on_human',
  'ci_wait',
  'activity_end',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** The six concern categories (kind === "concern"). */
export const CONCERN_KINDS = [
  'workaround',
  'di-seam',
  'forced-default',
  'gate-override',
  'self-approval',
  'unresolved-todo',
] as const;
export type ConcernKind = (typeof CONCERN_KINDS)[number];

/** Where a concern originated: a coded escape hatch, or an agent declaration. */
export const CONCERN_SOURCES = ['coded', 'declared'] as const;
export type ConcernSource = (typeof CONCERN_SOURCES)[number];

/** The canonical scope-tag key set carried by every event (Dev Spec §5.1). */
export const SCOPE_TAGS = [
  'activityId',
  'kind',
  'phase',
  'wave',
  'flight',
  'agent',
  'ts',
  'logRef',
] as const;

export class EventValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventValidationError';
  }
}

export type FlightDeckEvent = Record<string, unknown> & {
  kind: string;
  activityId: string;
  ts: string;
};

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/** ISO-8601 UTC timestamp, second precision (mirrors Python now_iso()). */
export function nowIso(): string {
  // e.g. 2026-07-07T12:34:56Z — drop the milliseconds/offset Date emits.
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function expanduser(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/** Resolve the durable buffer path (env override → default ~/.claude). */
export function bufferPath(): string {
  const override = process.env.FLIGHTDECK_EVENTS_PATH;
  if (override) return resolve(expanduser(override));
  return join(homedir(), '.claude', 'status', 'events.jsonl');
}

/** The offset-marker sidecar for `buffer` (records bytes already shipped). */
function offsetPath(buffer: string): string {
  return `${buffer}.offset`;
}

/**
 * Derive a stable activityId for a repo `root`.
 * FLIGHTDECK_ACTIVITY_ID wins; else the repo directory name; else "unknown".
 * Never throws.
 */
export function activityIdForRoot(root: unknown): string {
  const env = process.env.FLIGHTDECK_ACTIVITY_ID;
  if (env) return env;
  try {
    const name = resolve(String(root)).split('/').filter(Boolean).pop();
    return name || 'unknown';
  } catch {
    return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Event construction + validation (mirror of __init__.py)
// ---------------------------------------------------------------------------

// Optional scope keys → allowed JS typeof/shape (null always allowed).
const SCOPE_TYPES: Record<string, (v: unknown) => boolean> = {
  phase: (v) => typeof v === 'string',
  wave: (v) => typeof v === 'string',
  flight: (v) => typeof v === 'string' || (typeof v === 'number' && Number.isInteger(v)),
  agent: (v) => typeof v === 'string',
  logRef: (v) => typeof v === 'string',
};

/**
 * Construct a normalized, contract-shaped event. Stamps kind/activityId/ts/
 * schemaVersion. Fields whose value is `undefined` or `null` are dropped so the
 * buffered JSONL stays compact and optional scope tags are simply absent —
 * EXCEPT `value`, which is preserved even when null (a seamed-absent metric,
 * the #853 token stub, must round-trip honestly). Does NOT validate.
 */
export function buildEvent(
  kind: string,
  opts: { activityId: string; ts?: string; [k: string]: unknown },
): FlightDeckEvent {
  const { activityId, ts, ...fields } = opts;
  const event: FlightDeckEvent = {
    kind,
    activityId,
    ts: ts || nowIso(),
    schemaVersion: SCHEMA_VERSION,
  };
  for (const [key, val] of Object.entries(fields)) {
    if ((val === undefined || val === null) && key !== 'value') continue;
    event[key] = val;
  }
  return event;
}

/**
 * Validate `event` against the contract; throw EventValidationError.
 * Hand-rolled to mirror schema.json (no ajv dependency — the emit hot path
 * stays dependency-free). Same check order as the Python validator.
 */
export function validateEvent(event: unknown): void {
  if (typeof event !== 'object' || event === null || Array.isArray(event)) {
    throw new EventValidationError(`event must be an object, got ${event === null ? 'null' : typeof event}`);
  }
  const e = event as Record<string, unknown>;

  const kind = e.kind;
  if (typeof kind !== 'string' || !(EVENT_KINDS as readonly string[]).includes(kind)) {
    throw new EventValidationError(`invalid event kind ${JSON.stringify(kind)}; must be one of ${EVENT_KINDS.join('|')}`);
  }

  const activityId = e.activityId;
  if (typeof activityId !== 'string' || activityId.length === 0) {
    throw new EventValidationError("event 'activityId' must be a non-empty string");
  }

  const ts = e.ts;
  if (typeof ts !== 'string' || ts.length === 0) {
    throw new EventValidationError("event 'ts' must be a non-empty string");
  }

  for (const [key, ok] of Object.entries(SCOPE_TYPES)) {
    if (key in e && e[key] !== null && e[key] !== undefined) {
      if (!ok(e[key])) {
        throw new EventValidationError(`scope tag '${key}' must be a valid type or absent`);
      }
    }
  }

  if (kind === 'concern') {
    const ck = e.concernKind;
    if (typeof ck !== 'string' || !(CONCERN_KINDS as readonly string[]).includes(ck)) {
      throw new EventValidationError(`concern 'concernKind' must be one of ${CONCERN_KINDS.join('|')}, got ${JSON.stringify(ck)}`);
    }
    const src = e.source;
    if (typeof src !== 'string' || !(CONCERN_SOURCES as readonly string[]).includes(src)) {
      throw new EventValidationError(`concern 'source' must be one of ${CONCERN_SOURCES.join('|')}, got ${JSON.stringify(src)}`);
    }
  }

  if (kind === 'metric') {
    const name = e.metric;
    if (typeof name !== 'string' || name.length === 0) {
      throw new EventValidationError("metric event 'metric' (name) must be a non-empty string");
    }
  }
}

/**
 * Load + parse the vendored sibling schema.json contract. Used by the drift
 * test and any consumer that wants the raw schema; runtime validation
 * (validateEvent) does NOT depend on it. Never used on the emit hot path.
 */
export function loadSchema(): Record<string, unknown> {
  // import.meta.dir is a Bun extension resolving to this file's directory.
  const path = join(import.meta.dir, 'flightdeck', 'schema.json');
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Buffer write (atomic append) + offset marker
// ---------------------------------------------------------------------------

function atomicAppend(buffer: string, line: string): void {
  // appendFileSync opens with the O_APPEND flag; a single write of a small
  // record is serialized by the kernel (POSIX O_APPEND), so concurrent writers
  // never tear a line. Mirrors emit.py's os.write(O_APPEND) path.
  mkdirSync(dirname(buffer), { recursive: true });
  appendFileSync(buffer, line + '\n', { encoding: 'utf-8', mode: 0o644 });
}

function readOffset(buffer: string): number {
  try {
    const raw = readFileSync(offsetPath(buffer), 'utf-8').trim();
    const n = parseInt(raw || '0', 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

function writeOffset(buffer: string, offset: number): void {
  try {
    writeFileSync(offsetPath(buffer), String(offset), 'utf-8');
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Shipper (fire-and-forget POST + ordered replay)
// ---------------------------------------------------------------------------

/** Poster contract: POST body to url, resolve true on 2xx, false otherwise. */
export type Poster = (url: string, body: string) => Promise<boolean>;

async function defaultPost(url: string, body: string): Promise<boolean> {
  const token = process.env.FLIGHTDECK_INGEST_TOKEN;
  let timeoutSec = 2;
  const rawTimeout = process.env.FLIGHTDECK_INGEST_TIMEOUT;
  if (rawTimeout) {
    const parsed = Number(rawTimeout);
    if (Number.isFinite(parsed) && parsed > 0) timeoutSec = parsed;
  }
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const resp = await fetch(url, {
      method: 'POST',
      body,
      headers,
      signal: AbortSignal.timeout(timeoutSec * 1000),
    });
    return resp.status >= 200 && resp.status < 300;
  } catch {
    // A down/unreachable ingest returns false so the caller keeps the event
    // buffered for ordered replay (R-03). Never throws.
    return false;
  }
}

// Test seam — swap the poster so ship() is observable/deterministic in tests
// (mirrors the repo's __setSleep convention). Default is defaultPost (fetch).
let poster: Poster = defaultPost;
export function __setPoster(fn: Poster): void {
  poster = fn;
}
export function __resetPoster(): void {
  poster = defaultPost;
}

/**
 * Replay unsent buffered lines to the ingest endpoint, in order. Reads from the
 * offset marker to EOF; POSTs each complete line; advances the offset only past
 * a line that shipped 2xx. On the first failure it STOPS, leaving the offset at
 * the unshipped line so the next call resumes in order (R-04). Returns the
 * number of lines shipped. No-op (0) when FLIGHTDECK_INGEST_URL is unset
 * (DI-seam, R-03). Never throws.
 */
export async function ship(buffer?: string): Promise<number> {
  const url = process.env.FLIGHTDECK_INGEST_URL;
  if (!url) return 0;
  const buf = buffer || bufferPath();
  let shipped = 0;
  try {
    if (!existsSync(buf)) return 0;
    const data = readFileSync(buf); // Buffer of bytes
    let cursor = readOffset(buf);
    if (cursor > data.length) cursor = 0; // buffer truncated/rotated — restart
    while (cursor < data.length) {
      const nl = data.indexOf(0x0a, cursor);
      if (nl === -1) break; // partial line (a writer is mid-append) — retry next round
      const stripped = data.subarray(cursor, nl).toString('utf-8').trim();
      if (stripped.length > 0 && !(await poster(url, stripped))) break; // keep offset; ordered replay on recovery
      cursor = nl + 1;
      writeOffset(buf, cursor);
      if (stripped.length > 0) shipped += 1;
    }
  } catch {
    return shipped;
  }
  return shipped;
}

/** The spec's "replay unsent buffered lines" IS ship(). */
export const replay = ship;

function shipAsync(buffer: string): void {
  if (!process.env.FLIGHTDECK_INGEST_URL) return; // DI-seam: buffer-only, no shipper.
  // Fire-and-forget: never await, swallow any rejection so no unhandled promise.
  void ship(buffer).then(
    () => {},
    () => {},
  );
}

// ---------------------------------------------------------------------------
// emit — the one entrypoint
// ---------------------------------------------------------------------------

export interface EmitOptions {
  activityId?: string;
  wave?: string | null;
  phase?: string | null;
  flight?: string | number | null;
  agent?: string | null;
  logRef?: string | null;
  concernKind?: ConcernKind | string | null;
  source?: ConcernSource | string | null;
  metric?: string | null;
  /** Present-with-null distinguishes a seamed-absent metric from "not supplied". */
  value?: unknown;
  unit?: string | null;
  action?: string | null;
  label?: string | null;
  detail?: unknown;
  buffer?: string;
  shipNow?: boolean;
}

/**
 * Build, validate, buffer, and (non-blocking) ship one event. Returns the event
 * (or null if it could not be built/validated/buffered). NEVER throws
 * (R-01/R-03). An explicit `value: null` round-trips as JSON null (token stub).
 */
export function emit(kind: string, opts: EmitOptions = {}): FlightDeckEvent | null {
  if (process.env.FLIGHTDECK_EMIT_DISABLED) return null;

  try {
    const fields: Record<string, unknown> = {};
    const map: Array<[keyof EmitOptions, string]> = [
      ['wave', 'wave'],
      ['phase', 'phase'],
      ['flight', 'flight'],
      ['agent', 'agent'],
      ['logRef', 'logRef'],
      ['concernKind', 'concernKind'],
      ['source', 'source'],
      ['metric', 'metric'],
      ['unit', 'unit'],
      ['action', 'action'],
      ['label', 'label'],
      ['detail', 'detail'],
    ];
    for (const [optKey, schemaKey] of map) {
      const v = opts[optKey];
      if (v !== undefined && v !== null) fields[schemaKey] = v;
    }
    // `value` uses presence, not truthiness, so an explicit null round-trips.
    if ('value' in opts) fields.value = opts.value;

    const activityId =
      opts.activityId || process.env.FLIGHTDECK_ACTIVITY_ID || 'unknown';

    let event: FlightDeckEvent;
    try {
      event = buildEvent(kind, { activityId, ...fields });
      validateEvent(event);
    } catch {
      return null;
    }

    const buf = opts.buffer || bufferPath();
    try {
      atomicAppend(buf, JSON.stringify(event));
    } catch {
      return event; // built+validated but couldn't buffer — still never throw.
    }

    if (opts.shipNow !== false) shipAsync(buf);
    return event;
  } catch {
    // Absolute backstop — emit must never raise into a caller.
    return null;
  }
}

/**
 * Convenience wrapper for handlers that carry a repo `root`. Derives activityId
 * from root and picks up agent/logRef from the environment, then delegates to
 * emit(). Never throws. (Mirrors emit.py's emit_state_event.)
 */
export function emitStateEvent(
  root: unknown,
  kind: string,
  opts: EmitOptions = {},
): FlightDeckEvent | null {
  try {
    return emit(kind, {
      activityId: activityIdForRoot(root),
      agent: process.env.FLIGHTDECK_AGENT ?? null,
      logRef: process.env.FLIGHTDECK_LOG_REF ?? null,
      ...opts,
    });
  } catch {
    return null;
  }
}
