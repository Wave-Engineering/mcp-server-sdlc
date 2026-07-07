import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { readFileSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  emit,
  emitStateEvent,
  ship,
  replay,
  buildEvent,
  validateEvent,
  nowIso,
  bufferPath,
  activityIdForRoot,
  loadSchema,
  EventValidationError,
  SCHEMA_VERSION,
  EVENT_KINDS,
  CONCERN_KINDS,
  CONCERN_SOURCES,
  __setPoster,
  __resetPoster,
  type Poster,
} from '../lib/flightdeck_emit.ts';

// --- isolation: each test gets a fresh temp buffer + emit ENABLED ------------
let dir: string;
let buf: string;

// Snapshot + restore the env keys we mutate so tests never leak into each other
// (or into the preload's suite-wide FLIGHTDECK_EMIT_DISABLED default).
const ENV_KEYS = [
  'FLIGHTDECK_EMIT_DISABLED',
  'FLIGHTDECK_EVENTS_PATH',
  'FLIGHTDECK_INGEST_URL',
  'FLIGHTDECK_INGEST_TOKEN',
  'FLIGHTDECK_ACTIVITY_ID',
  'FLIGHTDECK_AGENT',
  'FLIGHTDECK_LOG_REF',
] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  dir = mkdtempSync(join(tmpdir(), 'fd-emit-'));
  buf = join(dir, 'events.jsonl');
  // Opt back in to emit for these tests; isolate the buffer to the temp dir.
  delete process.env.FLIGHTDECK_EMIT_DISABLED;
  process.env.FLIGHTDECK_EVENTS_PATH = buf;
  delete process.env.FLIGHTDECK_INGEST_URL; // buffer-only by default
  delete process.env.FLIGHTDECK_INGEST_TOKEN;
  delete process.env.FLIGHTDECK_ACTIVITY_ID;
  delete process.env.FLIGHTDECK_AGENT;
  delete process.env.FLIGHTDECK_LOG_REF;
  __resetPoster();
});

afterEach(() => {
  __resetPoster();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function readLines(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// Contract / drift guard — TS constants must equal schema.json enums (F-7).
// ---------------------------------------------------------------------------

describe('contract drift guard vs vendored schema.json', () => {
  test('EVENT_KINDS matches schema $defs.eventKind.enum', () => {
    const schema = loadSchema() as any;
    expect([...EVENT_KINDS]).toEqual(schema.$defs.eventKind.enum);
  });
  test('CONCERN_KINDS matches schema $defs.concernKind.enum', () => {
    const schema = loadSchema() as any;
    expect([...CONCERN_KINDS]).toEqual(schema.$defs.concernKind.enum);
  });
  test('CONCERN_SOURCES matches schema $defs.concernSource.enum', () => {
    const schema = loadSchema() as any;
    expect([...CONCERN_SOURCES]).toEqual(schema.$defs.concernSource.enum);
  });
  test('SCHEMA_VERSION matches schema.schemaVersion', () => {
    const schema = loadSchema() as any;
    expect(SCHEMA_VERSION).toBe(schema.schemaVersion);
  });
});

// ---------------------------------------------------------------------------
// nowIso
// ---------------------------------------------------------------------------

describe('nowIso', () => {
  test('is second-precision ISO-8601 UTC (Zulu, no millis)', () => {
    expect(nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});

// ---------------------------------------------------------------------------
// buildEvent / validateEvent
// ---------------------------------------------------------------------------

describe('buildEvent', () => {
  test('stamps kind/activityId/ts/schemaVersion and drops null/undefined fields', () => {
    const e = buildEvent('step', { activityId: 'camp-1', wave: null, phase: 'P1', flight: undefined });
    expect(e.kind).toBe('step');
    expect(e.activityId).toBe('camp-1');
    expect(e.schemaVersion).toBe(SCHEMA_VERSION);
    expect(typeof e.ts).toBe('string');
    expect(e.phase).toBe('P1');
    expect('wave' in e).toBe(false);
    expect('flight' in e).toBe(false);
  });

  test('preserves value even when null (seamed-absent metric / token stub)', () => {
    const e = buildEvent('metric', { activityId: 'a', metric: 'tokens', value: null });
    expect('value' in e).toBe(true);
    expect(e.value).toBeNull();
  });

  test('honors an explicit ts', () => {
    const e = buildEvent('phase', { activityId: 'a', ts: '2026-01-02T03:04:05Z' });
    expect(e.ts).toBe('2026-01-02T03:04:05Z');
  });
});

describe('validateEvent', () => {
  test('accepts a minimal valid event', () => {
    expect(() => validateEvent({ kind: 'step', activityId: 'a', ts: nowIso() })).not.toThrow();
  });
  test('rejects unknown kind', () => {
    expect(() => validateEvent({ kind: 'nope', activityId: 'a', ts: nowIso() })).toThrow(EventValidationError);
  });
  test('rejects empty activityId', () => {
    expect(() => validateEvent({ kind: 'step', activityId: '', ts: nowIso() })).toThrow(EventValidationError);
  });
  test('rejects missing ts', () => {
    expect(() => validateEvent({ kind: 'step', activityId: 'a' })).toThrow(EventValidationError);
  });
  test('concern requires concernKind + source', () => {
    expect(() => validateEvent({ kind: 'concern', activityId: 'a', ts: nowIso() })).toThrow(EventValidationError);
    expect(() =>
      validateEvent({ kind: 'concern', activityId: 'a', ts: nowIso(), concernKind: 'gate-override', source: 'coded' }),
    ).not.toThrow();
    expect(() =>
      validateEvent({ kind: 'concern', activityId: 'a', ts: nowIso(), concernKind: 'bogus', source: 'coded' }),
    ).toThrow(EventValidationError);
  });
  test('metric requires a non-empty metric name', () => {
    expect(() => validateEvent({ kind: 'metric', activityId: 'a', ts: nowIso() })).toThrow(EventValidationError);
    expect(() =>
      validateEvent({ kind: 'metric', activityId: 'a', ts: nowIso(), metric: 'drift', value: 3 }),
    ).not.toThrow();
  });
  test('rejects wrong-typed scope tag', () => {
    expect(() =>
      validateEvent({ kind: 'step', activityId: 'a', ts: nowIso(), wave: 123 }),
    ).toThrow(EventValidationError);
  });
  test('flight accepts string or integer', () => {
    expect(() => validateEvent({ kind: 'step', activityId: 'a', ts: nowIso(), flight: 2 })).not.toThrow();
    expect(() => validateEvent({ kind: 'step', activityId: 'a', ts: nowIso(), flight: 'f2' })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// emit — buffer append (the durable buffer is source of truth)
// ---------------------------------------------------------------------------

describe('emit — durable buffer', () => {
  test('appends one valid JSONL line to the isolated buffer', () => {
    const ev = emit('step', { activityId: 'camp-1', action: 'gate', label: 'trust' });
    expect(ev).not.toBeNull();
    const lines = readLines(buf);
    expect(lines).toHaveLength(1);
    expect(lines[0].kind).toBe('step');
    expect(lines[0].activityId).toBe('camp-1');
    expect(lines[0].action).toBe('gate');
    expect(lines[0].schemaVersion).toBe(SCHEMA_VERSION);
  });

  test('appends (does not truncate) across multiple emits', () => {
    emit('metric', { activityId: 'a', metric: 'drift', value: 1 });
    emit('metric', { activityId: 'a', metric: 'collision', value: 0 });
    emit('ci_wait', { activityId: 'a', label: 'passed' });
    expect(readLines(buf)).toHaveLength(3);
  });

  test('uses bufferPath() (FLIGHTDECK_EVENTS_PATH) when no explicit buffer', () => {
    expect(bufferPath()).toBe(buf);
    emit('phase', { activityId: 'a', phase: 'P0' });
    expect(existsSync(buf)).toBe(true);
  });

  test('a valid metric with value:null round-trips as JSON null', () => {
    emit('metric', { activityId: 'a', metric: 'tokens', value: null });
    const lines = readLines(buf);
    expect(lines[0].value).toBeNull();
    expect('value' in lines[0]).toBe(true);
  });

  test('concern event carries concernKind + source', () => {
    emit('concern', { activityId: 'a', concernKind: 'gate-override', source: 'coded', label: 'skip_train' });
    const lines = readLines(buf);
    expect(lines[0].kind).toBe('concern');
    expect(lines[0].concernKind).toBe('gate-override');
    expect(lines[0].source).toBe('coded');
  });
});

// ---------------------------------------------------------------------------
// emit — NEVER raises; invalid input is dropped, not thrown
// ---------------------------------------------------------------------------

describe('emit — never raises into the caller (R-01/R-03)', () => {
  test('invalid kind returns null and writes nothing (no throw)', () => {
    let ev: unknown;
    expect(() => {
      ev = emit('not-a-kind', { activityId: 'a' });
    }).not.toThrow();
    expect(ev).toBeNull();
    expect(readLines(buf)).toHaveLength(0);
  });

  test('concern missing required fields returns null (no throw)', () => {
    expect(() => emit('concern', { activityId: 'a' })).not.toThrow();
    expect(readLines(buf)).toHaveLength(0);
  });

  test('FLIGHTDECK_EMIT_DISABLED makes emit a no-op', () => {
    process.env.FLIGHTDECK_EMIT_DISABLED = '1';
    const ev = emit('step', { activityId: 'a' });
    expect(ev).toBeNull();
    expect(readLines(buf)).toHaveLength(0);
  });

  test('unwritable buffer path does not throw (built event still returned)', () => {
    // Write once so `buf` exists as a regular file.
    emit('step', { activityId: 'a' });
    expect(existsSync(buf)).toBe(true);
    // Point the buffer INSIDE that file → mkdirSync(dirname) treats a regular
    // file as a directory and throws ENOTDIR. emit must swallow it, not throw,
    // and still return the built+validated event (R-01 backstop).
    process.env.FLIGHTDECK_EVENTS_PATH = join(buf, 'events.jsonl');
    let ev: unknown = 'sentinel';
    expect(() => {
      ev = emit('step', { activityId: 'a' });
    }).not.toThrow();
    expect(ev).not.toBeNull();
    expect((ev as Record<string, unknown>).kind).toBe('step');
  });
});

// ---------------------------------------------------------------------------
// activityId resolution
// ---------------------------------------------------------------------------

describe('activityId resolution', () => {
  test('FLIGHTDECK_ACTIVITY_ID wins over explicit + root', () => {
    process.env.FLIGHTDECK_ACTIVITY_ID = 'pinned-campaign';
    expect(activityIdForRoot('/some/repo/foo')).toBe('pinned-campaign');
  });
  test('activityIdForRoot falls back to the dir name', () => {
    delete process.env.FLIGHTDECK_ACTIVITY_ID;
    expect(activityIdForRoot('/some/repo/mcp-server-sdlc')).toBe('mcp-server-sdlc');
  });
  test('emit defaults activityId to env then "unknown"', () => {
    delete process.env.FLIGHTDECK_ACTIVITY_ID;
    emit('step', {});
    expect(readLines(buf)[0].activityId).toBe('unknown');
  });
  test('emitStateEvent derives activityId from root and picks up agent/logRef env', () => {
    delete process.env.FLIGHTDECK_ACTIVITY_ID;
    process.env.FLIGHTDECK_AGENT = 'Gadget';
    process.env.FLIGHTDECK_LOG_REF = 'sess-123';
    emitStateEvent('/x/y/repo-z', 'phase', { phase: 'P1' });
    const line = readLines(buf)[0];
    expect(line.activityId).toBe('repo-z');
    expect(line.agent).toBe('Gadget');
    expect(line.logRef).toBe('sess-123');
    expect(line.phase).toBe('P1');
  });
});

// ---------------------------------------------------------------------------
// shipper (fire-and-forget POST + ordered replay) — DI-seam + offset marker
// ---------------------------------------------------------------------------

describe('ship / replay', () => {
  test('no-op (0) when FLIGHTDECK_INGEST_URL is unset (buffer-only)', async () => {
    emit('step', { activityId: 'a' });
    let posted = 0;
    __setPoster(async () => {
      posted += 1;
      return true;
    });
    const n = await ship();
    expect(n).toBe(0);
    expect(posted).toBe(0);
  });

  test('replay is an alias of ship', () => {
    expect(replay).toBe(ship);
  });

  test('ships all buffered lines in order and advances the offset', async () => {
    process.env.FLIGHTDECK_INGEST_URL = 'https://ingest.example/ingest';
    process.env.FLIGHTDECK_INGEST_TOKEN = 'sekret';
    // Emit with shipNow:false so we drive ship() deterministically.
    emit('metric', { activityId: 'a', metric: 'drift', value: 1, shipNow: false });
    emit('metric', { activityId: 'a', metric: 'collision', value: 0, shipNow: false });
    const seen: string[] = [];
    __setPoster(async (_url, body) => {
      seen.push(JSON.parse(body).metric);
      return true;
    });
    const n = await ship();
    expect(n).toBe(2);
    expect(seen).toEqual(['drift', 'collision']);
    // Offset advanced → a second ship ships nothing new.
    const again = await ship();
    expect(again).toBe(0);
  });

  test('stops at the first failed line, keeping order on recovery (R-04)', async () => {
    process.env.FLIGHTDECK_INGEST_URL = 'https://ingest.example/ingest';
    emit('step', { activityId: 'a', label: 'one', shipNow: false });
    emit('step', { activityId: 'a', label: 'two', shipNow: false });
    emit('step', { activityId: 'a', label: 'three', shipNow: false });

    let failFrom = 1; // succeed on the 1st line, fail on the 2nd
    let calls = 0;
    __setPoster(async () => {
      calls += 1;
      return calls <= failFrom;
    });
    const first = await ship();
    expect(first).toBe(1); // only "one" shipped

    // Ingest recovers — everything now succeeds; replay resumes at "two".
    const order: string[] = [];
    __setPoster(async (_url, body) => {
      order.push(JSON.parse(body).label);
      return true;
    });
    const second = await ship();
    expect(second).toBe(2);
    expect(order).toEqual(['two', 'three']);
  });

  test('emit(shipNow) default does not POST when URL unset', async () => {
    let posted = 0;
    __setPoster(async () => {
      posted += 1;
      return true;
    });
    emit('step', { activityId: 'a' }); // shipNow defaults true, but URL unset → no shipper
    // give any accidental async a tick
    await new Promise((r) => setTimeout(r, 5));
    expect(posted).toBe(0);
  });
});
