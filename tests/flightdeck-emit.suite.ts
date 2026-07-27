// FlightDeck emit suite — MERGED from the former flightdeck_emit.test.ts +
// handler_emit.test.ts, and deliberately NOT named *.test.ts.
//
// WHY THIS IS NOT A *.test.ts (CI-only isolation, #464)
// -----------------------------------------------------
// Bun runs every discovered test FILE concurrently in ONE process, sharing
// `process.env`. Both former FlightDeck files opt into emit per-test by deleting
// FLIGHTDECK_EMIT_DISABLED and pointing FLIGHTDECK_EVENTS_PATH at their own temp
// buffer, restoring in afterEach. When they ran as two sibling *.test.ts files,
// one file's afterEach restore of FLIGHTDECK_EMIT_DISABLED='1' (or the other's
// FLIGHTDECK_EVENTS_PATH) clobbered the other file mid-test → emit went no-op /
// wrote to the wrong buffer → the read threw ENOENT. Deterministic under CI's
// scheduler, invisible locally.
//
// THE FIX: merge both files into this ONE non-*.test.ts file so bun's default
// `bun test` discovery does NOT pick it up (it auto-discovers *.test.ts /
// *_test.ts / *.spec.ts). scripts/ci/validate.sh runs it in its OWN isolated
// bun process (`bun test tests/flightdeck-emit.suite.ts`) — a single FD file in
// that process means no concurrent FD file to race the shared env, so the
// per-test beforeEach delete is safe. Each former file's hooks/state live in its
// own top-level describe block below (block-scoped hooks, no cross-contamination).
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  readFileSync,
  existsSync,
  rmSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
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
import {
  installChildProcessMock,
  setExecMock,
  resetExecMock,
} from '../lib/test-support/mock-child-process.ts';

// Install the shared child_process mock at module top level, BEFORE the dynamic
// imports of the handlers-under-test (they bind execSync at import time).
installChildProcessMock();

const commutativityVerify = (await import('../handlers/commutativity_verify.ts')).default;
const driftFilesChanged = (await import('../handlers/drift_files_changed.ts')).default;
const driftCheckPathExists = (await import('../handlers/drift_check_path_exists.ts')).default;
const driftCheckSymbolExists = (await import('../handlers/drift_check_symbol_exists.ts')).default;
const ciWaitRunMod = await import('../handlers/ci_wait_run.ts');
const ciWaitRun = ciWaitRunMod.default;
const prMerge = (await import('../handlers/pr_merge.ts')).default;
const waveCiTrustMod = await import('../handlers/wave_ci_trust_level.ts');
const waveCiTrust = waveCiTrustMod.default;
const waveFinalize = (await import('../handlers/wave_finalize.ts')).default;
const { clearMergeQueueCache } = await import('../lib/merge_queue_detect.ts');

// ===========================================================================
// PART 1 — lib/flightdeck_emit.ts (durable buffer + validation + shipper)
// (former tests/flightdeck_emit.test.ts, verbatim, wrapped in a describe so its
//  hooks/state are block-scoped alongside PART 2's.)
// ===========================================================================
describe('flightdeck_emit (lib: buffer + validation + shipper)', () => {
  // --- isolation: each test gets a fresh temp buffer + emit ENABLED ----------
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

  // -------------------------------------------------------------------------
  // Contract / drift guard — TS constants must equal schema.json enums (F-7).
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // nowIso
  // -------------------------------------------------------------------------

  describe('nowIso', () => {
    test('is second-precision ISO-8601 UTC (Zulu, no millis)', () => {
      expect(nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    });
  });

  // -------------------------------------------------------------------------
  // buildEvent / validateEvent
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // emit — buffer append (the durable buffer is source of truth)
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // emit — NEVER raises; invalid input is dropped, not thrown
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // activityId resolution
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // shipper (fire-and-forget POST + ordered replay) — DI-seam + offset marker
  // -------------------------------------------------------------------------

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
});

// ===========================================================================
// PART 2 — wired non-CLI handlers → emit (S1.5)
// (former tests/handler_emit.test.ts, verbatim, wrapped in a describe. The
//  module-level installChildProcessMock() + dynamic handler imports live at the
//  top of this file, above PART 1, because they use top-level await.)
// ===========================================================================
//
// S1.5 — assert every wired non-CLI handler emits a correctly-typed + scoped
// FlightDeck event AFTER its work, and that the emit is ADDITIVE: an early
// (validation-error) return emits nothing, and emit never alters the handler's
// response. Handlers are driven end-to-end through the shared child_process
// mock with an isolated temp buffer, so we assert on the REAL emit path
// (buffer append), not a spy.
describe('handler_emit (wired handlers → emit)', () => {
  // --- isolation: temp buffer + emit ENABLED (preload disables it suite-wide) --
  let dir: string;
  let buf: string;
  const ENV_KEYS = [
    'FLIGHTDECK_EMIT_DISABLED',
    'FLIGHTDECK_EVENTS_PATH',
    'FLIGHTDECK_INGEST_URL',
    'FLIGHTDECK_ACTIVITY_ID',
    'FLIGHTDECK_AGENT',
    'FLIGHTDECK_LOG_REF',
    'CLAUDE_PROJECT_DIR',
  ] as const;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    dir = mkdtempSync(join(tmpdir(), 'fd-handler-'));
    buf = join(dir, 'events.jsonl');
    delete process.env.FLIGHTDECK_EMIT_DISABLED;
    process.env.FLIGHTDECK_EVENTS_PATH = buf;
    delete process.env.FLIGHTDECK_INGEST_URL; // buffer-only; no POST during tests
    delete process.env.FLIGHTDECK_ACTIVITY_ID;
    delete process.env.FLIGHTDECK_AGENT;
    delete process.env.FLIGHTDECK_LOG_REF;

    resetExecMock();
    setExecMock(() => '');
    clearMergeQueueCache();
    waveCiTrustMod.__resetCache();
    ciWaitRunMod.__setSleep(async () => {}); // no-op sleep
  });

  afterEach(() => {
    resetExecMock();
    ciWaitRunMod.__resetSleep();
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

  function readLines(): Array<Record<string, unknown>> {
    if (!existsSync(buf)) return [];
    return readFileSync(buf, 'utf-8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l));
  }

  function unquote(cmd: string): string {
    return cmd.replace(/'/g, '');
  }

  // Every emitted event must be a valid, scope-tagged contract event.
  function expectScoped(ev: Record<string, unknown>) {
    expect(typeof ev.kind).toBe('string');
    expect(typeof ev.activityId).toBe('string');
    expect((ev.activityId as string).length).toBeGreaterThan(0);
    expect(typeof ev.ts).toBe('string');
    expect(ev.schemaVersion).toBe(1);
  }

  // -------------------------------------------------------------------------
  // metric — collision (commutativity_verify)
  // -------------------------------------------------------------------------

  describe('commutativity_verify → metric(collision)', () => {
    test('emits a collision metric after the verdict', async () => {
      setExecMock((cmd) =>
        cmd.includes('commutativity-probe')
          ? JSON.stringify({ changesets: ['x'], flight_verdict: 'STRONG', pairs: [] })
          : '',
      );
      const res = await commutativityVerify.execute({
        repo_path: '/tmp/some-repo',
        base_ref: 'main',
        changesets: [{ id: 'cs1', head_ref: 'feature/1' }],
      });
      const body = JSON.parse(res.content[0].text);
      expect(body.ok).toBe(true); // response unchanged by emit

      const lines = readLines();
      expect(lines).toHaveLength(1);
      const ev = lines[0];
      expectScoped(ev);
      expect(ev.kind).toBe('metric');
      expect(ev.metric).toBe('collision');
      expect(ev.value).toBe(0);
      expect(ev.label).toBe('STRONG');
      expect(ev.activityId).toBe('some-repo'); // derived from repo_path
    });

    test('ADDITIVE: a validation-error early return emits nothing', async () => {
      const res = await commutativityVerify.execute({
        repo_path: '/tmp/some-repo',
        base_ref: 'main',
        changesets: [], // fails min(1) → early return before any work
      });
      const body = JSON.parse(res.content[0].text);
      expect(body.ok).toBe(false);
      expect(readLines()).toHaveLength(0);
    });

    test('pairwise mode: a pair MISSING an overlap array does NOT throw; emit stays safe', async () => {
      // Raw probe output for a pairwise call whose single pair omits the
      // `import_overlaps` array entirely (partial/malformed probe JSON). The
      // collision-count reduce must total the present arrays and treat the missing
      // one as 0 rather than dereferencing `undefined.length` and throwing a
      // TypeError that turns a valid WEAK verdict into an uncaught handler error.
      setExecMock((cmd) =>
        cmd.includes('commutativity-probe')
          ? JSON.stringify({
              changesets: ['feature/1', 'feature/2'],
              flight_verdict: 'WEAK',
              pairs: [
                {
                  a: 'feature/1',
                  b: 'feature/2',
                  verdict: 'WEAK',
                  reason: 'symbol cross-reference',
                  file_overlaps: ['lib/shared.ts'],
                  symbol_collisions: ['handlers/order.ts::processOrder'],
                  // import_overlaps intentionally absent
                },
              ],
            })
          : '',
      );
      const res = await commutativityVerify.execute({
        repo_path: '/tmp/some-repo',
        base_ref: 'main',
        changesets: [
          { id: 'cs1', head_ref: 'feature/1' },
          { id: 'cs2', head_ref: 'feature/2' },
        ],
      });
      // Handler returns its normal verdict (did NOT throw).
      const body = JSON.parse(res.content[0].text);
      expect(body.ok).toBe(true);
      expect(body.mode).toBe('pairwise');
      expect(body.verdict).toBe('WEAK');
      expect(body.group_verdict).toBe('WEAK');

      // Emit is safe: one collision metric, value = present overlaps only
      // (1 file + 1 symbol + 0 missing-import = 2).
      const lines = readLines();
      expect(lines).toHaveLength(1);
      const ev = lines[0];
      expectScoped(ev);
      expect(ev.kind).toBe('metric');
      expect(ev.metric).toBe('collision');
      expect(ev.value).toBe(2);
      expect(ev.label).toBe('WEAK');
    });
  });

  // -------------------------------------------------------------------------
  // metric — drift (drift_files_changed / _check_path_exists / _check_symbol_exists)
  // -------------------------------------------------------------------------

  describe('drift_files_changed → metric(drift)', () => {
    test('emits drift = number of files changed', async () => {
      setExecMock((cmd) => (cmd.includes('git diff') ? 'a.ts\nb.ts\n' : ''));
      const res = await driftFilesChanged.execute({ from_ref: 'main', to_ref: 'HEAD' });
      expect(JSON.parse(res.content[0].text).ok).toBe(true);
      const lines = readLines();
      expect(lines).toHaveLength(1);
      expectScoped(lines[0]);
      expect(lines[0].kind).toBe('metric');
      expect(lines[0].metric).toBe('drift');
      expect(lines[0].value).toBe(2);
    });

    test('ADDITIVE: missing from_ref early return emits nothing', async () => {
      const res = await driftFilesChanged.execute({});
      expect(JSON.parse(res.content[0].text).ok).toBe(false);
      expect(readLines()).toHaveLength(0);
    });
  });

  describe('drift_check_path_exists → metric(drift)', () => {
    test('emits drift = 0 when the path is present', async () => {
      setExecMock((cmd) => (cmd.includes('stat') ? 'regular file\n' : ''));
      const res = await driftCheckPathExists.execute({ path: 'README.md' });
      expect(JSON.parse(res.content[0].text).ok).toBe(true);
      const lines = readLines();
      expect(lines).toHaveLength(1);
      expect(lines[0].kind).toBe('metric');
      expect(lines[0].metric).toBe('drift');
      expect(lines[0].value).toBe(0);
      expect(lines[0].label).toBe('path-present');
    });

    test('emits drift = 1 when the path is missing', async () => {
      setExecMock((cmd) => {
        if (cmd.includes('stat')) throw new Error('stat: cannot stat: No such file');
        return '';
      });
      const res = await driftCheckPathExists.execute({ path: 'nope.md' });
      expect(JSON.parse(res.content[0].text).ok).toBe(true);
      const lines = readLines();
      expect(lines[0].value).toBe(1);
      expect(lines[0].label).toBe('path-missing');
    });
  });

  describe('drift_check_symbol_exists → metric(drift)', () => {
    test('emits drift = 0 when the symbol is found', async () => {
      const file = join(dir, 'mod.ts');
      writeFileSync(file, 'export function widget() {\n  return 1;\n}\n');
      const res = await driftCheckSymbolExists.execute({ file_path: file, symbol_name: 'widget' });
      const body = JSON.parse(res.content[0].text);
      expect(body.ok).toBe(true);
      expect(body.exists).toBe(true);
      const lines = readLines();
      expect(lines).toHaveLength(1);
      expect(lines[0].kind).toBe('metric');
      expect(lines[0].metric).toBe('drift');
      expect(lines[0].value).toBe(0);
      expect(lines[0].label).toBe('symbol-present');
    });
  });

  // -------------------------------------------------------------------------
  // ci_wait (ci_wait_run)
  // -------------------------------------------------------------------------

  describe('ci_wait_run → ci_wait', () => {
    test('emits a ci_wait event with the terminal status', async () => {
      setExecMock((cmd) => {
        const c = unquote(cmd);
        if (c.includes('run list')) {
          return JSON.stringify([
            {
              databaseId: 12345,
              name: 'CI',
              workflowName: 'CI',
              status: 'completed',
              conclusion: 'success',
              url: 'https://github.com/org/repo/actions/runs/12345',
              headSha: '1234567890abcdef1234567890abcdef12345678',
              headBranch: 'main',
              createdAt: '2026-04-07T12:00:00Z',
              event: 'push',
            },
          ]);
        }
        if (c.includes('remote')) return 'https://github.com/org/repo.git\n';
        return '';
      });
      const res = await ciWaitRun.execute({ ref: 'main' });
      const body = JSON.parse(res.content[0].text);
      expect(body.final_status).toBe('success');
      const lines = readLines();
      expect(lines).toHaveLength(1);
      expectScoped(lines[0]);
      expect(lines[0].kind).toBe('ci_wait');
      expect(lines[0].label).toBe('success');
    });
  });

  // -------------------------------------------------------------------------
  // step(gate) — wave_ci_trust_level
  // -------------------------------------------------------------------------

  describe('wave_ci_trust_level → step(gate)', () => {
    test('emits a gate step with the trust level', async () => {
      setExecMock((cmd) => {
        if (cmd.startsWith('git rev-parse')) return '/tmp/repo\n';
        if (cmd.startsWith('git remote')) return 'https://github.com/org/repo.git\n';
        if (cmd.includes('rulesets') && !/rulesets\/\d+/.test(cmd)) {
          return JSON.stringify([{ id: 1, enforcement: 'active' }]);
        }
        if (cmd.includes('rulesets/1')) return JSON.stringify({ rules: [{ type: 'merge_queue' }] });
        return '{}';
      });
      const res = await waveCiTrust.execute({});
      const body = JSON.parse(res.content[0].text);
      expect(body.ok).toBe(true);
      expect(body.level).toBe('pre_merge_authoritative');
      const lines = readLines();
      expect(lines).toHaveLength(1);
      expectScoped(lines[0]);
      expect(lines[0].kind).toBe('step');
      expect(lines[0].action).toBe('gate');
      expect(lines[0].label).toBe('pre_merge_authoritative');
    });
  });

  // -------------------------------------------------------------------------
  // step(promote) + concern(gate-override) — pr_merge
  // -------------------------------------------------------------------------

  describe('pr_merge → step(promote) + concern(gate-override)', () => {
    function stubMergeSuccess() {
      setExecMock((cmd) => {
        const c = unquote(cmd);
        if (c.includes('api graphql')) {
          return JSON.stringify({ data: { repository: { mergeQueue: null } } });
        }
        if (c.includes('pr view')) {
          return JSON.stringify({
            state: 'MERGED',
            url: 'https://github.com/org/repo/pull/42',
            mergeCommit: { oid: 'abc123def456' },
          });
        }
        if (c.includes('pr merge')) return '';
        if (c.includes('remote')) return 'https://github.com/org/repo.git\n';
        return '';
      });
    }

    test('emits a promote step (no gate-override without skip_train)', async () => {
      stubMergeSuccess();
      const res = await prMerge.execute({ number: 42 });
      expect(JSON.parse(res.content[0].text).ok).toBe(true);
      const kinds = readLines();
      const steps = kinds.filter((e) => e.kind === 'step');
      const concerns = kinds.filter((e) => e.kind === 'concern');
      expect(steps).toHaveLength(1);
      expect(steps[0].action).toBe('promote');
      expect(steps[0].label).toBe('pr_merge');
      expect(concerns).toHaveLength(0);
    });

    test('skip_train adds a coded gate-override concern', async () => {
      stubMergeSuccess();
      const res = await prMerge.execute({ number: 42, skip_train: true });
      expect(JSON.parse(res.content[0].text).ok).toBe(true);
      const lines = readLines();
      const concerns = lines.filter((e) => e.kind === 'concern');
      expect(concerns).toHaveLength(1);
      expectScoped(concerns[0]);
      expect(concerns[0].concernKind).toBe('gate-override');
      expect(concerns[0].source).toBe('coded');
      // still emits the promote step
      expect(lines.some((e) => e.kind === 'step' && e.action === 'promote')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // step(promote) + concern(self-approval) — wave_finalize
  // -------------------------------------------------------------------------

  describe('wave_finalize → step(promote) + concern(self-approval)', () => {
    function writeArtifact(root: string, rel: string, body: string) {
      const p = join(root, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, body);
    }

    test('created MR emits a promote step and a coded self-approval concern', async () => {
      const artRoot = join(dir, 'artifacts');
      writeArtifact(artRoot, 'wave-1/flight-1/issue-5/results.md', '# Results\n\nAdded widget.\nPR: https://github.com/o/r/pull/100\n');
      writeArtifact(artRoot, 'wave-1/flight-1/issue-6/results.md', '# Results\n\nFixed bug.\nPR: https://github.com/o/r/pull/101\n');

      const headRef = 'kahuna/42-demo';
      setExecMock((cmd) => {
        const c = unquote(cmd);
        if (c.includes('defaultBranchRef')) return 'main'; // #472: target_branch resolves to live default
        if (c.includes('ls-remote')) return `abc123\trefs/heads/${headRef}`;
        if (c.includes('pr list')) return '[]'; // no existing PR
        if (c.includes('pr create')) return 'https://github.com/o/r/pull/555';
        if (c.includes('pr view')) {
          return JSON.stringify({ number: 555, url: 'https://github.com/o/r/pull/555', state: 'OPEN', headRefName: headRef, baseRefName: 'main' });
        }
        if (c.includes('remote')) return 'git@github.com:o/r.git';
        return '';
      });

      const res = await waveFinalize.execute({
        plan_id: 42,
        kahuna_branch: headRef,
        target_branch: 'main',
        body_artifacts_dir: artRoot,
        root: dir,
      });
      const body = JSON.parse(res.content[0].text);
      expect(body.ok).toBe(true);
      expect(body.created).toBe(true); // response unchanged by emit

      const lines = readLines();
      const step = lines.find((e) => e.kind === 'step');
      const concern = lines.find((e) => e.kind === 'concern');
      expect(step).toBeDefined();
      expect(step!.action).toBe('promote');
      expect(step!.label).toBe('wave_finalize');
      expect(concern).toBeDefined();
      expectScoped(concern!);
      expect(concern!.concernKind).toBe('self-approval');
      expect(concern!.source).toBe('coded');
    });
  });

  // -------------------------------------------------------------------------
  // no POST during tests (buffer-only): FLIGHTDECK_INGEST_URL is unset, so the
  // emitted events live only in the isolated buffer — nothing escapes.
  // -------------------------------------------------------------------------

  describe('buffer-only isolation', () => {
    test('emitted events land in the isolated temp buffer, not the real one', async () => {
      expect(process.env.FLIGHTDECK_INGEST_URL).toBeUndefined();
      setExecMock((cmd) => (cmd.includes('git diff') ? 'x.ts\n' : ''));
      await driftFilesChanged.execute({ from_ref: 'main' });
      expect(existsSync(buf)).toBe(true);
      expect(readLines()).toHaveLength(1);
    });
  });
});
