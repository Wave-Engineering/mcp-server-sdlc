import { describe, test, expect, beforeEach } from 'bun:test';
import {
  installChildProcessMock,
  onExec,
  resetExecMock,
  execCalls,
} from '../test-support/mock-child-process.ts';
import { shellEscape } from '../shared/shell-escape.ts';

// Subprocess-boundary tests for the GitHub pr_wait_ci adapter (R-15).
// Integration-level coverage (handler dispatch, polling-loop behavior across
// multiple iterations) stays in tests/pr_wait_ci.test.ts. This file owns the
// argv-shape assertions that lock the gh<2.50 compat path (#220), the
// `classifyRollupItem` mapping table (14 cases), and the all-skipped
// regression (#221) end-to-end via the snapshot function.

interface ThrowableError extends Error {
  stderr?: string;
  stdout?: string;
  status?: number;
}

installChildProcessMock();

const {
  prWaitCiGithub,
  classifyRollupItem,
  snapshotGithub,
  emptyRollupBlocker,
  probeGithub,
  isUnfinished,
} = await import('./pr-wait-ci-github.ts');

beforeEach(() => {
  resetExecMock();
});

describe('snapshotGithub — argv shape (#220 regression)', () => {
  test('uses `gh pr view --json statusCheckRollup,url` (NOT `gh pr checks --json`)', () => {
    onExec(
      'gh pr view',
      JSON.stringify({
        url: 'https://github.com/org/repo/pull/5',
        statusCheckRollup: [
          { __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' },
        ],
      }),
    );

    const snap = snapshotGithub(5);
    expect(snap.total).toBe(1);
    expect(snap.passed).toBe(1);

    const viewCall = execCalls().find((c) => c.startsWith('gh pr view')) ?? '';
    expect(viewCall).toContain('gh pr view 5');
    expect(viewCall).toContain('--json');
    expect(viewCall).toContain('statusCheckRollup');
    expect(viewCall).toContain('url');
    // Regression guard for #220 — `gh pr checks --json` was added in a later
    // gh release and broke the handler on Ubuntu 24.04's default gh 2.45.
    expect(execCalls().some((c) => c.startsWith('gh pr checks'))).toBe(false);
  });

  test('threads --repo flag when provided', () => {
    onExec(
      'gh pr view',
      JSON.stringify({
        url: 'https://github.com/Wave-Engineering/mcp-server-sdlc/pull/42',
        statusCheckRollup: [
          { __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' },
        ],
      }),
    );

    snapshotGithub(42, 'Wave-Engineering/mcp-server-sdlc');
    const viewCall = execCalls().find((c) => c.startsWith('gh pr view')) ?? '';
    // #409: `repo` is now shell-escaped, so it appears single-quoted.
    expect(viewCall).toContain(`--repo 'Wave-Engineering/mcp-server-sdlc'`);
  });

  test('omits --repo when undefined', () => {
    onExec(
      'gh pr view',
      JSON.stringify({
        url: 'https://github.com/org/repo/pull/9',
        statusCheckRollup: [
          { __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' },
        ],
      }),
    );
    snapshotGithub(9);
    const viewCall = execCalls().find((c) => c.startsWith('gh pr view')) ?? '';
    expect(viewCall).not.toContain('--repo');
  });

  test('counts mixed CheckRun + StatusContext + SKIPPED correctly', () => {
    onExec(
      'gh pr view',
      JSON.stringify({
        url: 'https://github.com/org/repo/pull/77',
        statusCheckRollup: [
          { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
          { __typename: 'CheckRun', name: 'optional', status: 'COMPLETED', conclusion: 'SKIPPED' },
          { __typename: 'StatusContext', context: 'codecov/patch', state: 'SUCCESS' },
          { __typename: 'StatusContext', context: 'license/cla', state: 'PENDING' },
          { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' },
        ],
      }),
    );

    const snap = snapshotGithub(77);
    expect(snap.total).toBe(5); // includes the SKIPPED entry
    expect(snap.passed).toBe(2); // build + codecov
    expect(snap.failed).toBe(1); // lint
    expect(snap.pending).toBe(1); // license/cla
  });

  test('throws on gh failure (handler/poll-loop layer maps to AdapterResult)', () => {
    resetExecMock();
    onExec('gh pr view', () => {
      const err = new Error('HTTP 404: Not Found') as ThrowableError;
      err.stderr = 'HTTP 404: Not Found';
      err.status = 1;
      throw err;
    });
    expect(() => snapshotGithub(9999)).toThrow();
  });

  test('omits url when missing in response', () => {
    onExec(
      'gh pr view',
      JSON.stringify({ statusCheckRollup: [] }),
    );
    const snap = snapshotGithub(1);
    expect(snap.url).toBe('');
    expect(snap.total).toBe(0);
  });
});

// --- #409: shell-injection containment in the --repo flag ------------------
//
// `repoFlag` concatenates `repo` into the command string that `exec()` hands to
// `execSync`. A hostile value must stay inside a single shell-quoted argv token
// — never leak into shell-interpretable position. `repoOptionalSchema` already
// blocks metacharacters at the handler boundary; this is the defence-in-depth
// layer that survives any internal caller or refactor that bypasses the schema.
// Sibling to #403/#407 (pr-merge-github.ts) and #408 (pr-merge-gitlab.ts).
describe('repoFlag — shell-injection containment (#409)', () => {
  const HOSTILE = `sec/repo'; echo PWNED; #`;

  /**
   * The dangerous payload must appear ONLY inside the exact shell-escaped token.
   * Blanking that token out of the command string must leave nothing the shell
   * could act on — no `PWNED`, no stray `;`.
   */
  function assertContained(viewCall: string): void {
    const escaped = shellEscape(HOSTILE);
    // The raw value was shell-escaped before concatenation.
    expect(viewCall).toContain(`--repo ${escaped}`);
    // Nothing dangerous leaks outside that single quoted token.
    const withoutToken = viewCall.replace(escaped, '<REPO>');
    expect(withoutToken).not.toContain('PWNED');
    expect(withoutToken).not.toContain(';');
  }

  test('snapshotGithub — hostile repo stays inside a single quoted token', () => {
    onExec(
      'gh pr view',
      JSON.stringify({
        url: 'https://github.com/org/repo/pull/5',
        statusCheckRollup: [
          { __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' },
        ],
      }),
    );
    snapshotGithub(5, HOSTILE);
    const viewCall = execCalls().find((c) => c.startsWith('gh pr view')) ?? '';
    assertContained(viewCall);
  });

  test('probeGithub — hostile repo stays inside a single quoted token', () => {
    onExec(
      'gh pr view',
      JSON.stringify({
        url: 'https://github.com/org/repo/pull/5',
        statusCheckRollup: [],
        state: 'OPEN',
        isDraft: false,
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
      }),
    );
    probeGithub(5, HOSTILE);
    const viewCall = execCalls().find((c) => c.startsWith('gh pr view')) ?? '';
    assertContained(viewCall);
  });
});

// classifyRollupItem table — every branch documented in the JSDoc. Pure-function
// tests so the mapping can be exercised without a subprocess. (Mirrors the 14
// cases preserved from #220/#221 in tests/pr_wait_ci.test.ts.)
describe('classifyRollupItem — full mapping table', () => {
  test('CheckRun COMPLETED+SUCCESS → pass', () => {
    expect(classifyRollupItem({ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' })).toBe('pass');
  });

  test('CheckRun COMPLETED+NEUTRAL → pass', () => {
    expect(classifyRollupItem({ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'NEUTRAL' })).toBe('pass');
  });

  test('CheckRun COMPLETED+FAILURE → fail', () => {
    expect(classifyRollupItem({ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' })).toBe('fail');
  });

  test('CheckRun COMPLETED+CANCELLED → fail', () => {
    expect(classifyRollupItem({ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'CANCELLED' })).toBe('fail');
  });

  test('CheckRun COMPLETED+TIMED_OUT → fail', () => {
    expect(classifyRollupItem({ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'TIMED_OUT' })).toBe('fail');
  });

  test('CheckRun COMPLETED+STARTUP_FAILURE → fail', () => {
    expect(classifyRollupItem({ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'STARTUP_FAILURE' })).toBe('fail');
  });

  test('CheckRun COMPLETED+ACTION_REQUIRED → fail (needs human, not patience)', () => {
    expect(classifyRollupItem({ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'ACTION_REQUIRED' })).toBe('fail');
  });

  test('CheckRun IN_PROGRESS → pending', () => {
    expect(classifyRollupItem({ __typename: 'CheckRun', status: 'IN_PROGRESS' })).toBe('pending');
  });

  test('CheckRun QUEUED → pending', () => {
    expect(classifyRollupItem({ __typename: 'CheckRun', status: 'QUEUED' })).toBe('pending');
  });

  test('CheckRun COMPLETED+SKIPPED → skipping (uncounted)', () => {
    expect(classifyRollupItem({ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SKIPPED' })).toBe('skipping');
  });

  test('CheckRun COMPLETED+STALE → skipping (uncounted)', () => {
    expect(classifyRollupItem({ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'STALE' })).toBe('skipping');
  });

  test('StatusContext SUCCESS → pass', () => {
    expect(classifyRollupItem({ __typename: 'StatusContext', state: 'SUCCESS' })).toBe('pass');
  });

  test('StatusContext PENDING → pending', () => {
    expect(classifyRollupItem({ __typename: 'StatusContext', state: 'PENDING' })).toBe('pending');
  });

  test('StatusContext FAILURE → fail', () => {
    expect(classifyRollupItem({ __typename: 'StatusContext', state: 'FAILURE' })).toBe('fail');
  });

  test('StatusContext ERROR → fail', () => {
    expect(classifyRollupItem({ __typename: 'StatusContext', state: 'ERROR' })).toBe('fail');
  });

  test('unknown __typename → pending (defensive default)', () => {
    expect(classifyRollupItem({ __typename: 'FutureCheckType', status: 'COMPLETED', conclusion: 'SUCCESS' })).toBe('pending');
    expect(classifyRollupItem({})).toBe('pending');
  });
});

// All-skipped does NOT deadlock — #221 regression. Drives the full
// prWaitCiGithub path through the polling loop with a tight timeout/interval
// so a single snapshot iteration suffices.
describe('prWaitCiGithub — #221 all-skipped regression', () => {
  test('all SKIPPED checks → final_state passed on first poll', async () => {
    onExec(
      'gh pr view',
      JSON.stringify({
        url: 'https://github.com/org/repo/pull/1',
        statusCheckRollup: [
          { __typename: 'CheckRun', name: 'a', status: 'COMPLETED', conclusion: 'SKIPPED' },
          { __typename: 'CheckRun', name: 'b', status: 'COMPLETED', conclusion: 'SKIPPED' },
          { __typename: 'CheckRun', name: 'c', status: 'COMPLETED', conclusion: 'SKIPPED' },
        ],
      }),
    );

    const result = await prWaitCiGithub({
      number: 1,
      poll_interval_sec: 5,
      timeout_sec: 10,
    });

    if (!('ok' in result) || !result.ok) {
      throw new Error(`expected ok result, got ${JSON.stringify(result)}`);
    }
    if (!('final_state' in result.data)) {
      throw new Error(`expected polled-response shape, got ${JSON.stringify(result.data)}`);
    }
    expect(result.data.final_state).toBe('passed');
    expect(result.data.checks.passed).toBe(0);
    expect(result.data.checks.total).toBe(3); // total counts SKIPPED
    expect(result.data.checks.failed).toBe(0);
    expect(result.data.checks.pending).toBe(0);
  });
});

// --- #508: the settle window replaces #416's t=0 short-circuit -------------
//
// #416 returned `no_checks_required` on the FIRST empty rollup. An empty rollup
// is also exactly what a merely-QUEUED check looks like, so a PR whose CI had
// not started yet reported a definite, successful-sounding verdict with
// `elapsed_sec: 0`. Observed live on cc-workflow#1087: `pr_wait_ci` said
// no_checks_required while `gh pr checks` said `validate pending` seconds later.
//
// Every test here drives the settle loop through INJECTED seams — fake clock,
// fake sleep. A test that burned 45s of real wall-clock would be deleted by
// whoever next ran the suite, and this behaviour would go uncovered.

/** Fake clock whose `sleep` advances `now`, so the window elapses instantly. */
function fakeClock() {
  let t = 1_000_000;
  let slept = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
      slept += 1;
    },
    sleeps: () => slept,
  };
}

const HEAD_SHA = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

/** Local mirror of the adapter's RollupItem — the test imports values, not types. */
interface RollupLike {
  __typename?: string;
  name?: string;
  status?: string;
  conclusion?: string;
  state?: string;
}

function openMergeable(overrides: Record<string, unknown> = {}) {
  return {
    url: 'https://github.com/org/repo/pull/42',
    statusCheckRollup: [] as RollupLike[],
    state: 'OPEN',
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    headRefOid: HEAD_SHA,
    ...overrides,
  };
}

interface NoChecksData {
  status?: string;
  mergeable?: boolean;
  blocker?: string;
  elapsed_sec?: number;
  settled_sec?: number;
  url?: string;
  final_state?: string;
  pending_runs?: { run_id: number; workflow_name: string; status: string }[];
}

describe('prWaitCiGithub — settle window (#508)', () => {
  test('empty rollup, nothing ever registers, no runs for head SHA → no_checks_configured', async () => {
    const clock = fakeClock();
    const result = await prWaitCiGithub(
      { number: 42, poll_interval_sec: 5, timeout_sec: 1800 },
      {
        probe: () => openMergeable(),
        pendingRuns: async () => ({ ok: true, runs: [] }),
        now: clock.now,
        sleep: clock.sleep,
        settleWindowSec: 45,
        settlePollSec: 5,
      },
    );
    if (!('ok' in result) || !result.ok) throw new Error('expected ok');
    const data = result.data as NoChecksData;
    expect(data.status).toBe('no_checks_configured');
    expect(data.mergeable).toBe(true);
    expect(data.blocker).toBeUndefined();
    expect(data.pending_runs).toBeUndefined();
    // It actually waited rather than concluding at t=0.
    expect(clock.sleeps()).toBeGreaterThan(0);
    expect(data.settled_sec).toBeGreaterThanOrEqual(45);
  });

  test('THE BUG: a QUEUED run for the head SHA → no_checks_yet, never mergeable', async () => {
    const clock = fakeClock();
    const result = await prWaitCiGithub(
      { number: 42, poll_interval_sec: 5, timeout_sec: 1800 },
      {
        probe: () => openMergeable(),
        pendingRuns: async (sha) => {
          expect(sha).toBe(HEAD_SHA); // cross-check is anchored to the head SHA
          return { ok: true, runs: [{ run_id: 991, workflow_name: 'validate', status: 'queued' }] };
        },
        now: clock.now,
        sleep: clock.sleep,
        settleWindowSec: 45,
        settlePollSec: 5,
      },
    );
    if (!('ok' in result) || !result.ok) throw new Error('expected ok');
    const data = result.data as NoChecksData;
    expect(data.status).toBe('no_checks_yet');
    // The load-bearing assertion. CI exists and has not reported; a caller must
    // never read this as safe.
    expect(data.mergeable).toBe(false);
    expect(data.blocker).toBe('checks_not_registered');
    expect(data.pending_runs?.[0]?.workflow_name).toBe('validate');
    // The issue's named regression: `elapsed_sec: 0` must be impossible when a
    // queued run exists for the head SHA.
    expect(data.elapsed_sec).toBeGreaterThan(0);
  });

  test('a check that registers DURING the window falls through to the poll loop', async () => {
    // This is the actual fix: the PR gets a real passed/failed verdict instead
    // of any no-checks token at all.
    onExec(
      'gh pr view',
      JSON.stringify({
        url: 'https://github.com/org/repo/pull/42',
        statusCheckRollup: [
          { __typename: 'CheckRun', name: 'validate', status: 'COMPLETED', conclusion: 'SUCCESS' },
        ],
      }),
    );
    const clock = fakeClock();
    let probes = 0;
    const result = await prWaitCiGithub(
      { number: 42, poll_interval_sec: 5, timeout_sec: 60 },
      {
        probe: () => {
          probes += 1;
          return probes >= 3
            ? openMergeable({
                statusCheckRollup: [
                  { __typename: 'CheckRun', name: 'validate', status: 'QUEUED' },
                ],
              })
            : openMergeable();
        },
        pendingRuns: async () => {
          throw new Error('must not cross-check the ref once a check has registered');
        },
        now: clock.now,
        sleep: clock.sleep,
        settleWindowSec: 45,
        settlePollSec: 5,
      },
    );
    if (!('ok' in result) || !result.ok) throw new Error('expected ok');
    const data = result.data as NoChecksData;
    expect(data.final_state).toBe('passed');
    expect(data.status).toBeUndefined(); // polled shape, not a no-checks shape
  });

  test('hard blockers do NOT wait — waiting for a closed PR to start CI is pointless', async () => {
    for (const [probeOverride, expected] of [
      [{ state: 'CLOSED' }, 'closed'],
      [{ state: 'MERGED' }, 'merged'],
      [{ isDraft: true }, 'draft'],
      [{ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }, 'conflicts'],
    ] as [Record<string, unknown>, string][]) {
      const clock = fakeClock();
      const result = await prWaitCiGithub(
        { number: 42, poll_interval_sec: 5, timeout_sec: 1800 },
        {
          probe: () => openMergeable(probeOverride),
          pendingRuns: async () => {
            throw new Error('must not cross-check the ref for a blocked PR');
          },
          now: clock.now,
          sleep: clock.sleep,
          settleWindowSec: 45,
          settlePollSec: 5,
        },
      );
      if (!('ok' in result) || !result.ok) throw new Error('expected ok');
      const data = result.data as NoChecksData;
      expect(data.status).toBe('no_checks_configured');
      expect(data.blocker).toBe(expected);
      expect(data.mergeable).toBe(false);
      expect(data.settled_sec).toBe(0);
      // The ONE place a zero settle is correct — assert we truly did not sleep.
      expect(clock.sleeps()).toBe(0);
    }
  });

  test('the retired `no_checks_required` token is gone, not aliased', async () => {
    // Its plain-English name is the trap (skills/mmr/SKILL.md says so outright).
    // Keeping it as a synonym would preserve the ambiguity this issue is about.
    const clock = fakeClock();
    const result = await prWaitCiGithub(
      { number: 42, poll_interval_sec: 5, timeout_sec: 1800 },
      {
        probe: () => openMergeable(),
        pendingRuns: async () => ({ ok: true, runs: [] }),
        now: clock.now,
        sleep: clock.sleep,
        settleWindowSec: 10,
        settlePollSec: 5,
      },
    );
    if (!('ok' in result) || !result.ok) throw new Error('expected ok');
    expect((result.data as NoChecksData).status).not.toBe('no_checks_required');
  });

  test('a missing head SHA cannot certify "no CI" — it is no_checks_yet, not configured', async () => {
    // No anchor → the query cannot run → we have established NOTHING. Reporting
    // `no_checks_configured` here would be an instrument that examined nothing
    // returning the one answer a caller might merge on.
    const clock = fakeClock();
    const result = await prWaitCiGithub(
      { number: 42, poll_interval_sec: 5, timeout_sec: 1800 },
      {
        probe: () => openMergeable({ headRefOid: undefined }),
        pendingRuns: async () => {
          throw new Error('must not query runs without a head SHA to anchor to');
        },
        now: clock.now,
        sleep: clock.sleep,
        settleWindowSec: 10,
        settlePollSec: 5,
      },
    );
    if (!('ok' in result) || !result.ok) throw new Error('expected ok');
    const data = result.data as NoChecksData;
    expect(data.status).toBe('no_checks_yet');
    expect(data.blocker).toBe('evidence_unavailable');
    expect(data.mergeable).toBe(false);
  });

  test('a FAILED evidence query cannot report "no CI configured"', async () => {
    // The instrument-examined-nothing case, which is the shape this whole repo
    // is written against: a broken `gh` must not resolve to the mergeable answer.
    const clock = fakeClock();
    const result = await prWaitCiGithub(
      { number: 42, poll_interval_sec: 5, timeout_sec: 1800 },
      {
        probe: () => openMergeable(),
        pendingRuns: async () => ({ ok: false }),
        now: clock.now,
        sleep: clock.sleep,
        settleWindowSec: 10,
        settlePollSec: 5,
      },
    );
    if (!('ok' in result) || !result.ok) throw new Error('expected ok');
    const data = result.data as NoChecksData;
    expect(data.status).toBe('no_checks_yet');
    expect(data.blocker).toBe('evidence_unavailable');
    expect(data.mergeable).toBe(false);
  });

  test('non-empty rollup does NOT enter the settle window at all', async () => {
    // Regression — proves the whole addition is conditional on an empty rollup.
    onExec(
      'gh pr view',
      JSON.stringify({
        url: 'https://github.com/org/repo/pull/46',
        statusCheckRollup: [
          { __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' },
        ],
        state: 'OPEN',
        isDraft: false,
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
      }),
    );
    const clock = fakeClock();
    const result = await prWaitCiGithub(
      { number: 46, poll_interval_sec: 5, timeout_sec: 10 },
      { now: clock.now, sleep: clock.sleep },
    );
    if (!('ok' in result) || !result.ok) throw new Error('expected ok');
    const data = result.data as NoChecksData;
    expect(data.final_state).toBe('passed');
    expect(data.status).toBeUndefined();
    expect(clock.sleeps()).toBe(0);
  });
});

// --- evidence classifier: what counts as "CI is coming" (#508) --------------
describe('isUnfinished — only unfinished runs are evidence', () => {
  test('queued / in_progress / requested / waiting → evidence', () => {
    for (const s of ['queued', 'in_progress', 'requested', 'waiting', 'pending']) {
      expect(isUnfinished(s)).toBe(true);
    }
  });

  test('completed / cancelled / skipped → NOT evidence', () => {
    // A finished run that never produced a check is not "CI is coming" — it is
    // CI that already came and went (path-filtered job, skipped workflow).
    // Counting it would hold every such PR for the full window and then report
    // `no_checks_yet` forever, converting a spurious pass into a spurious hang.
    for (const s of ['completed', 'COMPLETED', 'cancelled', 'skipped']) {
      expect(isUnfinished(s)).toBe(false);
    }
  });
});


// --- pure mapper tests for the empty-rollup blocker classifier (#416) ------
describe('emptyRollupBlocker — pure mapping table', () => {
  test('OPEN + mergeable + not draft → null (no blocker)', () => {
    expect(emptyRollupBlocker({ state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' })).toBeNull();
  });

  test('OPEN + mergeable=true (boolean) → null', () => {
    expect(emptyRollupBlocker({ state: 'OPEN', isDraft: false, mergeable: true })).toBeNull();
  });

  test('CLOSED → closed', () => {
    expect(emptyRollupBlocker({ state: 'CLOSED', mergeable: 'MERGEABLE' })).toBe('closed');
  });

  test('MERGED → merged', () => {
    expect(emptyRollupBlocker({ state: 'MERGED', mergeable: 'MERGEABLE' })).toBe('merged');
  });

  test('isDraft=true → draft (even when mergeable)', () => {
    expect(emptyRollupBlocker({ state: 'OPEN', isDraft: true, mergeable: 'MERGEABLE' })).toBe('draft');
  });

  test('CONFLICTING → conflicts', () => {
    expect(emptyRollupBlocker({ state: 'OPEN', isDraft: false, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })).toBe('conflicts');
  });

  test('mergeable=UNKNOWN → not_mergeable (defensive)', () => {
    // GitHub returns UNKNOWN while it's still computing mergeability. We don't
    // promise the caller "yes mergeable" until GitHub has actually decided.
    expect(emptyRollupBlocker({ state: 'OPEN', isDraft: false, mergeable: 'UNKNOWN' })).toBe('not_mergeable');
  });

  test('mergeable=false (boolean) → not_mergeable', () => {
    expect(emptyRollupBlocker({ state: 'OPEN', isDraft: false, mergeable: false })).toBe('not_mergeable');
  });
});

describe('probeGithub — argv shape', () => {
  test('asks for statusCheckRollup,url,state,isDraft,mergeable,mergeStateStatus', () => {
    onExec(
      'gh pr view',
      JSON.stringify({
        url: 'https://github.com/org/repo/pull/1',
        statusCheckRollup: [],
        state: 'OPEN',
        isDraft: false,
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
      }),
    );
    probeGithub(1);
    const viewCall = execCalls().find((c) => c.startsWith('gh pr view')) ?? '';
    expect(viewCall).toContain('statusCheckRollup');
    expect(viewCall).toContain('url');
    expect(viewCall).toContain('state');
    expect(viewCall).toContain('isDraft');
    expect(viewCall).toContain('mergeable');
    expect(viewCall).toContain('mergeStateStatus');
  });
});

describe('prWaitCiGithub — failure surfaces as AdapterResult', () => {
  test('gh failure → ok:false, code unexpected_error', async () => {
    onExec('gh pr view', () => {
      const err = new Error('HTTP 404: Not Found') as ThrowableError;
      err.stderr = 'HTTP 404: Not Found';
      err.status = 1;
      throw err;
    });

    const result = await prWaitCiGithub({
      number: 9999,
      poll_interval_sec: 5,
      timeout_sec: 10,
    });
    if (!('ok' in result) || result.ok) {
      throw new Error(`expected error result, got ${JSON.stringify(result)}`);
    }
    expect(result.code).toBe('unexpected_error');
    expect(result.error).toContain('HTTP 404');
  });
});
