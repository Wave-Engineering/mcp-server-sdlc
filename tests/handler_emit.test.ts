import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  installChildProcessMock,
  setExecMock,
  resetExecMock,
} from '../lib/test-support/mock-child-process.ts';

// S1.5 — assert every wired non-CLI handler emits a correctly-typed + scoped
// FlightDeck event AFTER its work, and that the emit is ADDITIVE: an early
// (validation-error) return emits nothing, and emit never alters the handler's
// response. Handlers are driven end-to-end through the shared child_process
// mock with an isolated temp buffer, so we assert on the REAL emit path
// (buffer append), not a spy.

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

// ---------------------------------------------------------------------------
// metric — collision (commutativity_verify)
// ---------------------------------------------------------------------------

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
});

// ---------------------------------------------------------------------------
// metric — drift (drift_files_changed / _check_path_exists / _check_symbol_exists)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// ci_wait (ci_wait_run)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// step(gate) — wave_ci_trust_level
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// step(promote) + concern(gate-override) — pr_merge
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// step(promote) + concern(self-approval) — wave_finalize
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// no POST during tests (buffer-only): FLIGHTDECK_INGEST_URL is unset, so the
// emitted events live only in the isolated buffer — nothing escapes.
// ---------------------------------------------------------------------------

describe('buffer-only isolation', () => {
  test('emitted events land in the isolated temp buffer, not the real one', async () => {
    expect(process.env.FLIGHTDECK_INGEST_URL).toBeUndefined();
    setExecMock((cmd) => (cmd.includes('git diff') ? 'x.ts\n' : ''));
    await driftFilesChanged.execute({ from_ref: 'main' });
    expect(existsSync(buf)).toBe(true);
    expect(readLines()).toHaveLength(1);
  });
});
