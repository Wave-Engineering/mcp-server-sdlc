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
// (no-run-yet window, poll-to-completion, terminal
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
  // Default anchor satisfies BOTH platforms so existing tests are unaffected:
  // GitHub matches on head_sha (the ghRun default), GitLab on head_pipeline_id.
  resolveMergeAnchor: () => Promise<
    AdapterResult<import('./adapters/types.js').MergeAnchor>
  > = async () => ({
    ok: true,
    data: { head_sha: 'a'.repeat(40), head_pipeline_id: 1 },
  }),
): Pick<
  PlatformAdapter,
  'ciListRuns' | 'resolveBranchSha' | 'resolveMergeAnchor'
> {
  return { ciListRuns, resolveBranchSha, resolveMergeAnchor };
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

  
  
  test('a push-triggered run goes straight to the poll loop (regression)', async () => {
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

  
  test('Phase 1: no-run-yet then run appears and completes → success', async () => {
    const responses: NormalizedCiRun[][] = [
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

describe('require_merge_result — the wave trust gate contract (#476, #452)', () => {
  // Ref shapes VERIFIED against live GitLab (analogicdev). All three carry
  // source=merge_request_event; only /merge validates the merge:
  //   refs/merge-requests/N/merge  146x  merged-results   <-- the only valid signal
  //   refs/merge-requests/N/train   74x  merge-train
  //   refs/merge-requests/N/head    27x  DETACHED (branch HEAD)  <-- false pass
  const MERGE_REF = 'refs/merge-requests/108/merge';
  const HEAD_REF = 'refs/merge-requests/108/head';
  const TRAIN_REF = 'refs/merge-requests/108/train';

  const PR = 108;
  const HEAD_PIPELINE = 500; // what GitLab says is current for the MR head
  const PR_HEAD_SHA = 'b'.repeat(40); // what GitHub says is the PR head

  const anchorOk = async () => ({
    ok: true as const,
    data: { head_sha: PR_HEAD_SHA, head_pipeline_id: HEAD_PIPELINE },
  });

  const glGate = {
    ref: 'kahuna/1-x',
    platform: 'gitlab' as const,
    require_merge_result: true,
    pr_number: PR,
  };
  const ghGate = {
    ref: 'kahuna/1-x',
    platform: 'github' as const,
    require_merge_result: true,
    pr_number: PR,
  };

  // A merged-results pipeline that GitLab considers CURRENT for the MR head.
  const freshMr = (o: Partial<NormalizedCiRun> = {}): NormalizedCiRun =>
    glPipeline({
      run_id: HEAD_PIPELINE,
      event: 'merge_request_event',
      head_branch: MERGE_REF,
      head_sha: 'f'.repeat(40), // ephemeral merge commit — never the branch head
      ...o,
    });

  const gl = (o: Partial<NormalizedCiRun>) =>
    makeAdapter(async () => ({ ok: true, data: [glPipeline(o)] }), undefined, anchorOk);

  test('THE FALSE PASS: a DETACHED (/head) pipeline is refused — it validated the branch HEAD', async () => {
    const adapter = makeAdapter(
      async () => ({
        ok: true,
        data: [freshMr({ status: 'success', head_branch: HEAD_REF })],
      }),
      undefined,
      anchorOk,
    );
    const c = fakeClock();
    const r = await waitForRun(glGate, { adapter, sleep: c.sleep, now: c.now });
    expect(r.final_status).toBe('not_merge_result');
    expect(r.final_status).not.toBe('success');
  });

  test('a merge-TRAIN (/train) pipeline is refused too', async () => {
    const adapter = makeAdapter(
      async () => ({ ok: true, data: [freshMr({ status: 'success', head_branch: TRAIN_REF })] }),
      undefined,
      anchorOk,
    );
    const c = fakeClock();
    const r = await waitForRun(glGate, { adapter, sleep: c.sleep, now: c.now });
    expect(r.final_status).toBe('not_merge_result');
  });

  test('THE STALE PASS: a GREEN merge-result run for a PREVIOUS commit is refused (no branch run present)', async () => {
    // This is the case the earlier negative heuristic missed entirely: there is
    // NO sibling push run to compare against (GitHub pull_request-only workflows
    // and GitLab's dedup rule both produce none). The ONLY thing that saves us is
    // the positive anchor: GitLab says pipeline 500 is current; this is 499.
    const adapter = makeAdapter(
      async () => ({
        ok: true,
        data: [freshMr({ run_id: 499, status: 'success' })], // stale, and GREEN
      }),
      undefined,
      anchorOk,
    );
    const c = fakeClock();
    const r = await waitForRun(
      { ...glGate, timeout_sec: 30 },
      { adapter, sleep: c.sleep, now: c.now },
    );
    expect(r.ok).toBe(false);
    expect(r.final_status).toBe('not_merge_result'); // classified, not a generic no-run error
    expect(r.final_status).not.toBe('success');
    if (!r.ok) expect(r.error).toMatch(/CURRENT head/i);
  });

  test('GitHub: a stale pull_request run (wrong head_sha) is refused', async () => {
    const adapter = makeAdapter(
      async () => ({
        ok: true,
        data: [
          ghRun({
            status: 'completed',
            conclusion: 'success',
            event: 'pull_request',
            head_sha: 'c'.repeat(40), // NOT the PR head
          }),
        ],
      }),
      undefined,
      anchorOk,
    );
    const c = fakeClock();
    const r = await waitForRun(
      { ...ghGate, timeout_sec: 30 },
      { adapter, sleep: c.sleep, now: c.now },
    );
    expect(r.final_status).toBe('not_merge_result');
    expect(r.final_status).not.toBe('success');
  });

  test('GitHub: a pull_request run AT the PR head is accepted', async () => {
    const adapter = makeAdapter(
      async () => ({
        ok: true,
        data: [
          ghRun({
            run_id: 9,
            status: 'completed',
            conclusion: 'success',
            event: 'pull_request',
            head_sha: PR_HEAD_SHA,
          }),
        ],
      }),
      undefined,
      anchorOk,
    );
    const c = fakeClock();
    const r = await waitForRun(ghGate, { adapter, sleep: c.sleep, now: c.now });
    expect(r.ok).toBe(true);
    expect(r.final_status).toBe('success');
    if (r.ok) expect(r.run_id).toBe(9);
  });

  test('the CURRENT merge-result run IS accepted (#452: skipped branch + green merge result)', async () => {
    const adapter = makeAdapter(
      async () => ({
        ok: true,
        data: [
          glPipeline({ run_id: 1, status: 'skipped', event: 'push', head_branch: 'kahuna/1-x' }),
          freshMr({ status: 'success' }),
        ],
      }),
      undefined,
      anchorOk,
    );
    const c = fakeClock();
    const r = await waitForRun(glGate, { adapter, sleep: c.sleep, now: c.now });
    expect(r.ok).toBe(true);
    expect(r.final_status).toBe('success');
    if (r.ok) expect(r.run_id).toBe(HEAD_PIPELINE); // the merge result, not the skipped branch
  });

  test('a SKIPPED branch pipeline can no longer be graded as success', async () => {
    const adapter = gl({ status: 'skipped', event: 'push', head_branch: 'kahuna/1-x' });
    const c1 = fakeClock();
    const legacy = await waitForRun(
      { ref: 'kahuna/1-x', platform: 'gitlab' },
      { adapter, sleep: c1.sleep, now: c1.now },
    );
    expect(legacy.final_status).toBe('success'); // legacy path unchanged

    const c2 = fakeClock();
    const gated = await waitForRun(
      { ...glGate, timeout_sec: 30 },
      { adapter, sleep: c2.sleep, now: c2.now },
    );
    expect(gated.final_status).toBe('not_merge_result');
    expect(gated.final_status).not.toBe('success');
  });

  test('GitHub: pull_request run with conclusion=skipped validated nothing → refused', async () => {
    const adapter = makeAdapter(
      async () => ({
        ok: true,
        data: [
          ghRun({
            status: 'completed',
            conclusion: 'skipped',
            event: 'pull_request',
            head_sha: PR_HEAD_SHA,
          }),
        ],
      }),
      undefined,
      anchorOk,
    );
    const c = fakeClock();
    const r = await waitForRun(
      { ...ghGate, timeout_sec: 30 },
      { adapter, sleep: c.sleep, now: c.now },
    );
    expect(r.final_status).toBe('not_merge_result');
  });

  test('FAIL CLOSED: require_merge_result without pr_number is refused, not guessed', async () => {
    const adapter = makeAdapter(
      async () => ({ ok: true, data: [freshMr({ status: 'success' })] }),
      undefined,
      anchorOk,
    );
    const c = fakeClock();
    const r = await waitForRun(
      { ref: 'kahuna/1-x', platform: 'gitlab', require_merge_result: true },
      { adapter, sleep: c.sleep, now: c.now },
    );
    expect(r.ok).toBe(false);
    expect(r.final_status).toBe('not_merge_result');
    if (!r.ok) expect(r.error).toMatch(/pr_number/);
  });

  test('FAIL CLOSED: an unresolvable anchor HOLDs (e.g. MR has no head_pipeline)', async () => {
    const adapter = makeAdapter(
      async () => ({ ok: true, data: [freshMr({ status: 'success' })] }),
      undefined,
      async () => ({ ok: false as const, code: 'no_head_pipeline', error: 'MR !108 has no head_pipeline' }),
    );
    const c = fakeClock();
    const r = await waitForRun(glGate, { adapter, sleep: c.sleep, now: c.now });
    expect(r.ok).toBe(false);
    expect(r.final_status).toBe('not_merge_result');
    expect(r.final_status).not.toBe('success');
  });

  test('CROSS-PLATFORM: a GitLab-shaped anchor cannot satisfy a GitHub run', async () => {
    // route.ts picks the adapter by slug shape; the handler computes `platform`
    // independently. A mismatch must HOLD, never pass.
    const adapter = makeAdapter(
      async () => ({
        ok: true,
        data: [
          ghRun({ status: 'completed', conclusion: 'success', event: 'pull_request', head_sha: PR_HEAD_SHA }),
        ],
      }),
      undefined,
      async () => ({ ok: true as const, data: { head_pipeline_id: HEAD_PIPELINE } }),
    );
    const c = fakeClock();
    const r = await waitForRun({ ...ghGate, timeout_sec: 30 }, { adapter, sleep: c.sleep, now: c.now });
    expect(r.final_status).toBe('not_merge_result');
    expect(r.final_status).not.toBe('success');
  });

  test('CROSS-PLATFORM: a GitHub-shaped anchor cannot satisfy a GitLab run', async () => {
    const adapter = makeAdapter(
      async () => ({ ok: true, data: [freshMr({ status: 'success' })] }),
      undefined,
      async () => ({ ok: true as const, data: { head_sha: PR_HEAD_SHA } }),
    );
    const c = fakeClock();
    const r = await waitForRun({ ...glGate, timeout_sec: 30 }, { adapter, sleep: c.sleep, now: c.now });
    expect(r.final_status).toBe('not_merge_result');
  });

  test('an EMPTY anchor holds on both platforms', async () => {
    const ghAdapter = makeAdapter(
      async () => ({
        ok: true,
        data: [ghRun({ status: 'completed', conclusion: 'success', event: 'pull_request', head_sha: PR_HEAD_SHA })],
      }),
      undefined,
      async () => ({ ok: true as const, data: {} }),
    );
    const c1 = fakeClock();
    const r1 = await waitForRun({ ...ghGate, timeout_sec: 30 }, { adapter: ghAdapter, sleep: c1.sleep, now: c1.now });
    expect(r1.final_status).toBe('not_merge_result');

    const glAdapter = makeAdapter(
      async () => ({ ok: true, data: [freshMr({ status: 'success' })] }),
      undefined,
      async () => ({ ok: true as const, data: {} }),
    );
    const c2 = fakeClock();
    const r2 = await waitForRun({ ...glGate, timeout_sec: 30 }, { adapter: glAdapter, sleep: c2.sleep, now: c2.now });
    expect(r2.final_status).toBe('not_merge_result');
  });

  test('TOCTOU: the PR head moving mid-wait refuses the completed run', async () => {
    // Anchor resolves to pipeline 500; by the time the run completes, GitLab says
    // the MR head pipeline is 501 — the run we watched validated the OLD head.
    let call = 0;
    const adapter = makeAdapter(
      async () => ({ ok: true, data: [freshMr({ status: 'success' })] }),
      undefined,
      async () => {
        call += 1;
        return call === 1
          ? { ok: true as const, data: { head_pipeline_id: HEAD_PIPELINE } }
          : { ok: true as const, data: { head_pipeline_id: HEAD_PIPELINE + 1 } };
      },
    );
    const c = fakeClock();
    const r = await waitForRun(glGate, { adapter, sleep: c.sleep, now: c.now });
    expect(r.ok).toBe(false);
    expect(r.final_status).toBe('not_merge_result');
    expect(r.final_status).not.toBe('success');
    if (!r.ok) expect(r.error).toMatch(/moved while|PREVIOUS head/i);
  });

  test('a FAILING current merge-result run still fails — the flag gates the KIND, not the verdict', async () => {
    const adapter = makeAdapter(
      async () => ({ ok: true, data: [freshMr({ status: 'failed' })] }),
      undefined,
      anchorOk,
    );
    const c = fakeClock();
    const r = await waitForRun(glGate, { adapter, sleep: c.sleep, now: c.now });
    expect(r.ok).toBe(true);
    expect(r.final_status).toBe('failure');
  });

  test('default (flag absent) unchanged — /mmr\'s branch watch still passes', async () => {
    const adapter = makeAdapter(async () => ({
      ok: true,
      data: [ghRun({ status: 'completed', conclusion: 'success', event: 'push' })],
    }));
    const c = fakeClock();
    const r = await waitForRun(
      { ref: 'main', platform: 'github' },
      { adapter, sleep: c.sleep, now: c.now },
    );
    expect(r.final_status).toBe('success');
  });
});
