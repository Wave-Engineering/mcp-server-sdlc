import { describe, test, expect } from 'bun:test';
import { waitForRun } from './ci-wait-run-poll.ts';
import type {
  AdapterResult,
  CiListRunsArgs,
  CiListRunsResponse,
  NormalizedCiRun,
  PlatformAdapter,
  ResolveBranchShaArgs,
  ResolveBranchShaResponse,
} from './adapters/types.ts';

// Platform-agnostic polling loop tests (R-15). The loop's job is to orchestrate
// the `ciListRuns` + `resolveBranchSha` sub-calls across the four phases
// (merge-queue pre-flight, no-run-yet window, poll-to-completion, terminal
// normalization). These tests drive it directly with an injected adapter and a
// fake clock — zero subprocess work, zero real time.

type CiListRunsImpl = (
  args: CiListRunsArgs,
) => Promise<AdapterResult<CiListRunsResponse>>;
type ResolveBranchShaImpl = (
  args: ResolveBranchShaArgs,
) => Promise<AdapterResult<ResolveBranchShaResponse | null>>;

function makeAdapter(
  ciListRuns: CiListRunsImpl,
  resolveBranchSha: ResolveBranchShaImpl = async () => ({
    ok: true,
    data: null,
  }),
): Pick<PlatformAdapter, 'ciListRuns' | 'resolveBranchSha'> {
  return { ciListRuns, resolveBranchSha };
}

function ghRun(overrides: Partial<NormalizedCiRun> = {}): NormalizedCiRun {
  return {
    run_id: 1,
    workflow_name: 'CI',
    status: 'in_progress',
    conclusion: null,
    url: 'https://github.com/org/repo/actions/runs/1',
    head_sha: 'a'.repeat(40),
    head_branch: 'main',
    created_at: '2026-04-07T12:00:00Z',
    event: 'push',
    ...overrides,
  };
}

function glPipeline(overrides: Partial<NormalizedCiRun> = {}): NormalizedCiRun {
  return {
    run_id: 1,
    workflow_name: 'push',
    status: 'running',
    conclusion: null,
    url: 'https://gitlab.com/org/repo/-/pipelines/1',
    head_sha: 'a'.repeat(40),
    head_branch: 'main',
    created_at: '2026-04-07T12:00:00Z',
    event: null,
    ...overrides,
  };
}

function fakeClock() {
  let now = 1_700_000_000_000;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('waitForRun — phase machine', () => {
  test('Phase 3: GitHub run already complete with success → final_status=success', async () => {
    const adapter = makeAdapter(async () => ({
      ok: true,
      data: [ghRun({ status: 'completed', conclusion: 'success' })],
    }));
    const clock = fakeClock();

    const result = await waitForRun(
      { ref: 'main', platform: 'github' },
      { adapter, sleep: clock.sleep, now: clock.now },
    );
    expect(result.ok).toBe(true);
    expect(result.final_status).toBe('success');
    expect(result.run_id).toBe(1);
  });

  test('Phase 3: GitHub failure conclusion → final_status=failure', async () => {
    const adapter = makeAdapter(async () => ({
      ok: true,
      data: [ghRun({ status: 'completed', conclusion: 'failure' })],
    }));
    const clock = fakeClock();

    const result = await waitForRun(
      { ref: 'main', platform: 'github' },
      { adapter, sleep: clock.sleep, now: clock.now },
    );
    expect(result.ok).toBe(true);
    expect(result.final_status).toBe('failure');
  });

  test('Phase 3: GitHub cancelled → final_status=cancelled', async () => {
    const adapter = makeAdapter(async () => ({
      ok: true,
      data: [ghRun({ status: 'completed', conclusion: 'cancelled' })],
    }));
    const clock = fakeClock();

    const result = await waitForRun(
      { ref: 'main', platform: 'github' },
      { adapter, sleep: clock.sleep, now: clock.now },
    );
    expect(result.final_status).toBe('cancelled');
  });

  test('Phase 3: unknown conclusion → ok:false with error', async () => {
    const adapter = makeAdapter(async () => ({
      ok: true,
      data: [ghRun({ status: 'completed', conclusion: 'mystery' })],
    }));
    const clock = fakeClock();

    const result = await waitForRun(
      { ref: 'main', platform: 'github' },
      { adapter, sleep: clock.sleep, now: clock.now },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('mystery');
  });

  test('Phase 0: merge_group-only repo with matching SHA → not_applicable success', async () => {
    const sha = 'b'.repeat(40);
    const adapter = makeAdapter(async () => ({
      ok: true,
      data: [
        ghRun({
          run_id: 555,
          status: 'completed',
          conclusion: 'success',
          event: 'merge_group',
          head_sha: sha,
          url: 'https://github.com/org/repo/actions/runs/555',
        }),
      ],
    }));
    const clock = fakeClock();

    const result = await waitForRun(
      { ref: sha, platform: 'github' },
      { adapter, sleep: clock.sleep, now: clock.now },
    );
    expect(result.ok).toBe(true);
    expect(result.final_status).toBe('not_applicable');
    if (result.ok) {
      expect(result.reason).toBe('merge_group_validated');
      expect(result.run_id).toBe(555);
      expect(result.waited_sec).toBe(0);
    }
  });

  test('Phase 0: merge_group-only with NO matching SHA → not_applicable error', async () => {
    const refSha = 'c'.repeat(40);
    const otherSha = 'd'.repeat(40);
    const adapter = makeAdapter(async () => ({
      ok: true,
      data: [
        ghRun({
          run_id: 444,
          status: 'completed',
          conclusion: 'success',
          event: 'merge_group',
          head_sha: otherSha,
        }),
      ],
    }));
    const clock = fakeClock();

    const result = await waitForRun(
      { ref: refSha, platform: 'github' },
      { adapter, sleep: clock.sleep, now: clock.now },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.final_status).toBe('not_applicable');
      expect(result.error).toContain('no push-triggered workflows');
    }
  });

  test('Phase 0: push-triggered run present → falls through to poll loop (regression)', async () => {
    const adapter = makeAdapter(async () => ({
      ok: true,
      data: [
        ghRun({
          run_id: 777,
          status: 'completed',
          conclusion: 'success',
          event: 'push',
        }),
      ],
    }));
    const clock = fakeClock();

    const result = await waitForRun(
      { ref: 'main', platform: 'github' },
      { adapter, sleep: clock.sleep, now: clock.now },
    );
    expect(result.ok).toBe(true);
    expect(result.final_status).toBe('success');
    if (result.ok) expect(result.run_id).toBe(777);
  });

  test('Phase 0: merge_group branch ref resolves via resolveBranchSha', async () => {
    const targetSha = 'e'.repeat(40);
    const adapter = makeAdapter(
      async () => ({
        ok: true,
        data: [
          ghRun({
            run_id: 888,
            status: 'completed',
            conclusion: 'success',
            event: 'merge_group',
            head_sha: targetSha,
          }),
        ],
      }),
      async () => ({ ok: true, data: { sha: targetSha } }),
    );
    const clock = fakeClock();

    const result = await waitForRun(
      {
        ref: 'feature/1-demo',
        repo: 'explicit-org/explicit-repo',
        platform: 'github',
      },
      { adapter, sleep: clock.sleep, now: clock.now },
    );
    expect(result.ok).toBe(true);
    expect(result.final_status).toBe('not_applicable');
    if (result.ok) expect(result.reason).toBe('merge_group_validated');
  });

  test('Phase 1: no-run-yet then run appears and completes → success', async () => {
    const responses: NormalizedCiRun[][] = [
      [], // pre-flight
      [], // phase 1 poll 1
      [ghRun({ status: 'in_progress' })], // phase 1 poll 2 → transition to phase 2
      [ghRun({ status: 'completed', conclusion: 'success' })], // phase 2
    ];
    let call = 0;
    const adapter = makeAdapter(async () => {
      const data = responses[Math.min(call, responses.length - 1)];
      call++;
      return { ok: true, data };
    });
    const clock = fakeClock();

    const result = await waitForRun(
      { ref: 'main', platform: 'github' },
      { adapter, sleep: clock.sleep, now: clock.now },
    );
    expect(result.ok).toBe(true);
    expect(result.final_status).toBe('success');
  });

  test('Phase 1: no run ever appears → timeout error with helpful message', async () => {
    const adapter = makeAdapter(async () => ({ ok: true, data: [] }));
    const clock = fakeClock();

    const result = await waitForRun(
      { ref: 'main', platform: 'github', timeout_sec: 30, poll_interval_sec: 10 },
      { adapter, sleep: clock.sleep, now: clock.now },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.toLowerCase()).toContain('no ci run found');
      expect(result.waited_sec).toBeGreaterThanOrEqual(30);
    }
  });

  test('Phase 2: stays in_progress past timeout → final_status=timed_out', async () => {
    const adapter = makeAdapter(async () => ({
      ok: true,
      data: [ghRun({ status: 'in_progress' })],
    }));
    const clock = fakeClock();

    const result = await waitForRun(
      { ref: 'main', platform: 'github', timeout_sec: 30, poll_interval_sec: 10 },
      { adapter, sleep: clock.sleep, now: clock.now },
    );
    expect(result.ok).toBe(true);
    expect(result.final_status).toBe('timed_out');
    if (result.ok) expect(result.waited_sec).toBeGreaterThanOrEqual(30);
  });

  test('workflow_name filter: non-matching runs are skipped', async () => {
    const adapter = makeAdapter(async () => ({
      ok: true,
      data: [
        ghRun({ run_id: 111, workflow_name: 'Lint', status: 'in_progress' }),
        ghRun({
          run_id: 222,
          workflow_name: 'Build',
          status: 'completed',
          conclusion: 'success',
        }),
      ],
    }));
    const clock = fakeClock();

    const result = await waitForRun(
      { ref: 'main', workflow_name: 'Build', platform: 'github' },
      { adapter, sleep: clock.sleep, now: clock.now },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.run_id).toBe(222);
      expect(result.final_status).toBe('success');
    }
  });

  test('expected_sha filters out runs whose head_sha mismatches (defense-in-depth)', async () => {
    const target = 'a'.repeat(40);
    const other = 'b'.repeat(40);
    const adapter = makeAdapter(async () => ({
      ok: true,
      data: [
        ghRun({
          run_id: 1,
          status: 'completed',
          conclusion: 'success',
          head_sha: other,
        }),
        ghRun({
          run_id: 2,
          status: 'completed',
          conclusion: 'success',
          head_sha: target,
          created_at: '2026-04-08T12:01:00Z',
          event: 'push',
        }),
      ],
    }));
    const clock = fakeClock();

    const result = await waitForRun(
      {
        ref: 'main',
        expected_sha: target,
        platform: 'github',
        timeout_sec: 600,
        poll_interval_sec: 10,
      },
      { adapter, sleep: clock.sleep, now: clock.now },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.run_id).toBe(2);
      expect(result.sha).toBe(target);
    }
  });

  test('GitLab: running → success maps to final_status=success (status normalization)', async () => {
    const responses: NormalizedCiRun[][] = [
      [glPipeline({ status: 'running' })],
      [glPipeline({ status: 'success' })],
    ];
    let call = 0;
    const adapter = makeAdapter(async () => {
      const data = responses[Math.min(call, responses.length - 1)];
      call++;
      return { ok: true, data };
    });
    const clock = fakeClock();

    const result = await waitForRun(
      { ref: 'main', platform: 'gitlab' },
      { adapter, sleep: clock.sleep, now: clock.now },
    );
    expect(result.ok).toBe(true);
    expect(result.final_status).toBe('success');
  });

  test('GitLab: failed maps to final_status=failure', async () => {
    const adapter = makeAdapter(async () => ({
      ok: true,
      data: [glPipeline({ status: 'failed' })],
    }));
    const clock = fakeClock();

    const result = await waitForRun(
      { ref: 'main', platform: 'gitlab' },
      { adapter, sleep: clock.sleep, now: clock.now },
    );
    expect(result.ok).toBe(true);
    expect(result.final_status).toBe('failure');
  });

  test('GitLab: canceled maps to final_status=cancelled', async () => {
    const adapter = makeAdapter(async () => ({
      ok: true,
      data: [glPipeline({ status: 'canceled' })],
    }));
    const clock = fakeClock();

    const result = await waitForRun(
      { ref: 'main', platform: 'gitlab' },
      { adapter, sleep: clock.sleep, now: clock.now },
    );
    expect(result.final_status).toBe('cancelled');
  });

  test('adapter error surfaces as top-level ok:false', async () => {
    const adapter = makeAdapter(async () => ({
      ok: false,
      code: 'gh_run_list_failed',
      error: 'gh: not authenticated',
    }));
    const clock = fakeClock();

    const result = await waitForRun(
      { ref: 'main', platform: 'github' },
      { adapter, sleep: clock.sleep, now: clock.now },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('gh: not authenticated');
  });

  test('poll_interval_sec hard floor — values below 5 clamp to 5', async () => {
    const responses: NormalizedCiRun[][] = [
      [ghRun({ status: 'in_progress' })],
      [ghRun({ status: 'in_progress' })],
      [ghRun({ status: 'completed', conclusion: 'success' })],
    ];
    let call = 0;
    const sleeps: number[] = [];
    const adapter = makeAdapter(async () => {
      const data = responses[Math.min(call, responses.length - 1)];
      call++;
      return { ok: true, data };
    });
    const clock = fakeClock();
    const sleep = async (ms: number) => {
      sleeps.push(ms);
      await clock.sleep(ms);
    };

    const result = await waitForRun(
      { ref: 'main', platform: 'github', poll_interval_sec: 1 },
      { adapter, sleep, now: clock.now },
    );
    expect(result.ok).toBe(true);
    // At least one sleep at exactly 5000ms (the clamped floor).
    const mainLoopSleeps = sleeps.filter((ms) => ms === 5000);
    expect(mainLoopSleeps.length).toBeGreaterThan(0);
  });
});
