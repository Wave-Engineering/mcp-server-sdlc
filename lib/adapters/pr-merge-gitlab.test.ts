import { describe, test, expect, beforeEach } from 'bun:test';
import {
  installChildProcessMock,
  onExec,
  resetExecMock,
  execCalls,
} from '../test-support/mock-child-process.ts';
import type { AdapterResult, PrMergeResponse } from './types.ts';

// Subprocess-boundary tests for the GitLab pr_merge adapter (R-15).
// Integration-level coverage stays in tests/pr_merge.test.ts.

interface ThrowableError extends Error {
  stderr?: string;
  stdout?: string;
  status?: number;
}

function unquote(cmd: string): string {
  return cmd.replace(/'([^']*)'/g, '$1');
}

installChildProcessMock();

const { prMergeGitlab } = await import('./pr-merge-gitlab.ts');

function expectOk(
  r: AdapterResult<PrMergeResponse>,
): asserts r is { ok: true; data: PrMergeResponse } {
  if (!('ok' in r) || !r.ok) {
    throw new Error(`expected ok result, got ${JSON.stringify(r)}`);
  }
}

function expectErr(
  r: AdapterResult<PrMergeResponse>,
): asserts r is { ok: false; error: string; code: string } {
  if (!('ok' in r) || r.ok) {
    throw new Error(`expected error result, got ${JSON.stringify(r)}`);
  }
}

function findCall(needle: string): string {
  return execCalls().find((c) => c.includes(needle) || unquote(c).includes(needle)) ?? '';
}

beforeEach(() => {
  resetExecMock();
  // Story 1.11 routes prMergeGitlab's post-merge state lookup through
  // getAdapter().fetchPrState(...) — which calls detectPlatform(). Stub the
  // cwd-remote so detection picks GitLab and the routed call lands on
  // fetchPrStateGitlab (matching this adapter's intent).
  onExec('git remote get-url origin', 'https://gitlab.com/org/repo.git\n');
});

describe('prMergeGitlab — subprocess boundary', () => {
  test('direct merge returns aggregate envelope', async () => {
    onExec('glab mr merge 17 --squash --remove-source-branch --yes', '');
    onExec(
      'glab api projects/org%2Frepo/merge_requests/17',
      JSON.stringify({
        iid: 17,
        state: 'merged',
        source_branch: 'feature/test',
        target_branch: 'main',
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/17',
        labels: [],
        sha: 'head17aaaaaa',
        merge_commit_sha: 'deadbeef1234',
      }),
    );

    const result = await prMergeGitlab({ number: 17, repo: 'org/repo' });
    expectOk(result);
    expect(result.data).toEqual({
      number: 17,
      enrolled: true,
      merged: true,
      merge_method: 'direct_squash',
      queue: { enabled: false, position: null, enforced: false },
      pr_state: 'MERGED',
      url: 'https://gitlab.com/org/repo/-/merge_requests/17',
      merge_commit_sha: 'deadbeef1234',
      warnings: [],
      queue_fallback: false,
      graphql_fallback: false,
    });
    // No `gh api graphql` call should ever fire on the GitLab path.
    expect(execCalls().find((c) => c.includes('gh api graphql'))).toBeUndefined();
  });

  test('skip_train is silently dropped — merge proceeds with warning (#423)', async () => {
    onExec('glab mr merge 9 --squash --remove-source-branch --yes', '');
    onExec(
      'glab api projects/org%2Frepo/merge_requests/9',
      JSON.stringify({
        iid: 9,
        state: 'merged',
        source_branch: 'feature/train',
        target_branch: 'main',
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/9',
        labels: [],
        sha: 'head9bbbbbbb',
        merge_commit_sha: 'abc123def456',
      }),
    );

    const result = await prMergeGitlab({ number: 9, skip_train: true, repo: 'org/repo' });
    expectOk(result);
    expect(result.data.merged).toBe(true);
    expect(result.data.warnings).toContain(
      'skip_train ignored on GitLab — merge trains are auto-managed at the project level',
    );
  });

  test('skip_train omitted — no warning in response', async () => {
    onExec('glab mr merge 10 --squash --remove-source-branch --yes', '');
    onExec(
      'glab api projects/org%2Frepo/merge_requests/10',
      JSON.stringify({
        iid: 10,
        state: 'merged',
        source_branch: 'feature/no-train',
        target_branch: 'main',
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/10',
        labels: [],
        sha: 'head10cccccc',
        merge_commit_sha: 'deadbeef0000',
      }),
    );

    const result = await prMergeGitlab({ number: 10, repo: 'org/repo' });
    expectOk(result);
    expect(result.data.warnings).toEqual([]);
  });

  test('returns AdapterResult{ok:false, code} on glab failure (not thrown)', async () => {
    // #486: sha resolution runs BEFORE the merge, so this fixture is required
    // for the call to reach the merge at all — without it the adapter refuses
    // earlier with `gitlab_head_sha_unresolved` and this test's intent (the
    // merge itself failing) would never be exercised.
    onExec(
      'glab api projects/org%2Frepo/merge_requests/9',
      JSON.stringify({
        iid: 9,
        state: 'opened',
        source_branch: 'feature/conflict',
        target_branch: 'main',
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/9',
        labels: [],
        sha: 'head9conflict',
        merge_commit_sha: null,
      }),
    );
    onExec('glab mr merge 9 --squash --remove-source-branch --yes', () => {
      const err = new Error('merge request cannot be merged') as ThrowableError;
      err.stderr = 'merge request has conflicts\n';
      throw err;
    });

    const result = await prMergeGitlab({ number: 9, repo: 'org/repo' });
    expectErr(result);
    expect(result.code).toBe('glab_mr_merge_failed');
    expect(result.error).toContain('glab mr merge failed');
  });

  test('squash message → --squash-message inline', async () => {
    onExec('glab mr merge 14 --squash --remove-source-branch --yes', '');
    onExec(
      'glab api projects/org%2Frepo/merge_requests/14',
      JSON.stringify({
        iid: 14,
        state: 'merged',
        source_branch: 'feature/fix',
        target_branch: 'main',
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/14',
        labels: [],
        sha: 'head14dddddd',
        merge_commit_sha: 'f00dbabe',
      }),
    );

    const result = await prMergeGitlab({
      number: 14,
      squash_message: 'fix: patch',
      repo: 'org/repo',
    });
    expectOk(result);
    const mergeCall = findCall('glab mr merge 14');
    expect(mergeCall).toContain("--squash-message 'fix: patch'");
  });

  test('-R flag forwarded when args.repo provided (GitLab uses -R, not --repo)', async () => {
    onExec('glab mr merge 17 --squash --remove-source-branch --yes', '');
    onExec(
      'glab api projects/target-org%2Ftarget-repo/merge_requests/17',
      JSON.stringify({
        iid: 17,
        state: 'merged',
        source_branch: 'feature/test',
        target_branch: 'main',
        web_url: 'https://gitlab.com/target-org/target-repo/-/merge_requests/17',
        labels: [],
        sha: 'head17eeeeee',
        merge_commit_sha: 'deadbeef',
      }),
    );

    const result = await prMergeGitlab({
      number: 17,
      repo: 'target-org/target-repo',
    });
    expectOk(result);
    const mergeCall = findCall('glab mr merge 17');
    expect(mergeCall).toContain("-R 'target-org/target-repo'");
    const apiCall = findCall('glab api projects/');
    expect(apiCall).toContain('target-org%2Ftarget-repo');
  });
});

// #486 — GitLab rejects the merge with `400 SHA must be provided when merging`
// when the project enforces pipelines-must-succeed and/or squash. `glab mr
// merge` does not supply `sha`, so the adapter resolves the source-branch HEAD
// and passes `--sha` explicitly.
describe('prMergeGitlab — --sha stale-head guard (#486)', () => {
  test('passes --sha with the MR source-branch head sha', async () => {
    onExec('glab mr merge 17 --squash --remove-source-branch --yes', '');
    onExec(
      'glab api projects/org%2Frepo/merge_requests/17',
      JSON.stringify({
        iid: 17,
        state: 'merged',
        source_branch: 'feature/test',
        target_branch: 'main',
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/17',
        labels: [],
        sha: 'head17aaaaaa',
        merge_commit_sha: 'deadbeef1234',
      }),
    );

    const result = await prMergeGitlab({ number: 17, repo: 'org/repo' });
    expectOk(result);
    const mergeCall = findCall('glab mr merge 17');
    expect(mergeCall).toContain("--sha 'head17aaaaaa'");
    // Must be the diff head, never the merge commit produced by the merge.
    expect(mergeCall).not.toContain('deadbeef1234');
  });

  test('prefers diff_refs.head_sha over the top-level sha when both are present', async () => {
    // Pins the precedence. Values agree in practice, so only a fixture with
    // BOTH present and DIFFERING proves which one the code actually reads.
    onExec('glab mr merge 22 --squash --remove-source-branch --yes', '');
    onExec(
      'glab api projects/org%2Frepo/merge_requests/22',
      JSON.stringify({
        iid: 22,
        state: 'merged',
        source_branch: 'feature/precedence',
        target_branch: 'main',
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/22',
        labels: [],
        sha: 'TOPLEVELsha22',
        diff_refs: { head_sha: 'DIFFREFShead22' },
        merge_commit_sha: 'merged22',
      }),
    );

    const result = await prMergeGitlab({ number: 22, repo: 'org/repo' });
    expectOk(result);
    const mergeCall = findCall('glab mr merge 22');
    expect(mergeCall).toContain("--sha 'DIFFREFShead22'");
    expect(mergeCall).not.toContain('TOPLEVELsha22');
  });

  test('uses diff_refs.head_sha when the top-level sha is absent', async () => {
    onExec('glab mr merge 21 --squash --remove-source-branch --yes', '');
    onExec(
      'glab api projects/org%2Frepo/merge_requests/21',
      JSON.stringify({
        iid: 21,
        state: 'merged',
        source_branch: 'feature/diffrefs',
        target_branch: 'main',
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/21',
        labels: [],
        diff_refs: { base_sha: 'base00', head_sha: 'head21ffffff', start_sha: 'start00' },
        merge_commit_sha: 'cafe2121',
      }),
    );

    const result = await prMergeGitlab({ number: 21, repo: 'org/repo' });
    expectOk(result);
    expect(findCall('glab mr merge 21')).toContain("--sha 'head21ffffff'");
  });

  test('falls back to the top-level sha when diff_refs is absent', async () => {
    onExec('glab mr merge 23 --squash --remove-source-branch --yes', '');
    onExec(
      'glab api projects/org%2Frepo/merge_requests/23',
      JSON.stringify({
        iid: 23,
        state: 'merged',
        source_branch: 'feature/toplevel',
        target_branch: 'main',
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/23',
        labels: [],
        sha: 'topLevelOnly23',
        // no diff_refs at all — the fallback branch
        merge_commit_sha: 'merged23',
      }),
    );

    const result = await prMergeGitlab({ number: 23, repo: 'org/repo' });
    expectOk(result);
    expect(findCall('glab mr merge 23')).toContain("--sha 'topLevelOnly23'");
  });

  test('refuses loudly and does NOT merge when head sha is unresolvable', async () => {
    onExec('glab mr merge 30 --squash --remove-source-branch --yes', '');
    onExec(
      'glab api projects/org%2Frepo/merge_requests/30',
      JSON.stringify({
        iid: 30,
        state: 'opened',
        source_branch: 'feature/nosha',
        target_branch: 'main',
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/30',
        labels: [],
        // no `sha`, no `diff_refs` — nothing to guard the merge with
        merge_commit_sha: null,
      }),
    );

    const result = await prMergeGitlab({ number: 30, repo: 'org/repo' });
    expectErr(result);
    expect(result.code).toBe('gitlab_head_sha_unresolved');
    expect(result.error).toContain('refusing to merge without it');
    // The critical assertion: we must never fall through to an unguarded merge.
    expect(execCalls().find((c) => c.includes('glab mr merge 30'))).toBeUndefined();
  });

  test('surfaces a typed refusal when the MR lookup itself fails', async () => {
    onExec('glab api projects/org%2Frepo/merge_requests/31', () => {
      const err = new Error('glab api failed') as ThrowableError;
      err.stderr = '404 Project Not Found\n';
      throw err;
    });

    const result = await prMergeGitlab({ number: 31, repo: 'org/repo' });
    expectErr(result);
    expect(result.code).toBe('gitlab_head_sha_unresolved');
    expect(execCalls().find((c) => c.includes('glab mr merge 31'))).toBeUndefined();
  });

  test('disables auto-merge so a pending pipeline cannot silently ENROLL', async () => {
    // `glab mr merge --auto-merge` defaults to true. Left on, an MR with a
    // pending pipeline is enrolled rather than merged, and this adapter would
    // report merged:false/OPEN while claiming merge_method:'direct_squash'.
    onExec('glab mr merge 40 --squash --remove-source-branch --yes', '');
    onExec(
      'glab api projects/org%2Frepo/merge_requests/40',
      JSON.stringify({
        iid: 40,
        state: 'merged',
        source_branch: 'feature/auto',
        target_branch: 'main',
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/40',
        labels: [],
        sha: 'head40aaaaaa',
        merge_commit_sha: 'merged40',
      }),
    );

    const result = await prMergeGitlab({ number: 40, repo: 'org/repo' });
    expectOk(result);
    expect(findCall('glab mr merge 40')).toContain('--auto-merge=false');
  });

  test('stale-head 409 is retried with a re-resolved sha, not failed', async () => {
    // TOCTOU: the source branch moves between resolving the sha and merging.
    // GitLab answers 409; the adapter must refetch and retry, not fail.
    let mrReads = 0;
    onExec('glab api projects/org%2Frepo/merge_requests/41', () => {
      mrReads += 1;
      return JSON.stringify({
        iid: 41,
        state: mrReads >= 3 ? 'merged' : 'opened',
        source_branch: 'feature/moving',
        target_branch: 'main',
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/41',
        labels: [],
        // Head advances after the first read — that is the race.
        diff_refs: { head_sha: mrReads === 1 ? 'staleHEAD01' : 'freshHEAD02' },
        merge_commit_sha: mrReads >= 3 ? 'merged41' : null,
      });
    });

    let mergeAttempts = 0;
    onExec('glab mr merge 41 --squash --remove-source-branch --yes', () => {
      mergeAttempts += 1;
      if (mergeAttempts === 1) {
        const err = new Error('merge failed') as ThrowableError;
        err.stderr = '409 SHA does not match HEAD of source branch\n';
        throw err;
      }
      return '';
    });

    const result = await prMergeGitlab({ number: 41, repo: 'org/repo' });
    expectOk(result);
    expect(mergeAttempts).toBe(2);
    // The retry must use the REFRESHED head, not replay the stale one.
    const calls = execCalls().filter((c) => c.includes('glab mr merge 41'));
    expect(calls[0]).toContain("--sha 'staleHEAD01'");
    expect(calls[1]).toContain("--sha 'freshHEAD02'");
  });

  test('exhausted stale-head retries stop at the bound and return a DISTINCT code', async () => {
    // Pins the retry bound. Without this, turning the loop unbounded still
    // passes the rest of the suite. Also pins that "the branch kept moving" is
    // distinguishable from "this MR cannot merge" WITHOUT string-matching.
    let mrReads = 0;
    onExec('glab api projects/org%2Frepo/merge_requests/43', () => {
      mrReads += 1;
      return JSON.stringify({
        iid: 43,
        state: 'opened',
        source_branch: 'feature/always-moving',
        target_branch: 'main',
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/43',
        labels: [],
        diff_refs: { head_sha: `movingHEAD${String(mrReads)}` },
        merge_commit_sha: null,
      });
    });

    let mergeAttempts = 0;
    onExec('glab mr merge 43 --squash --remove-source-branch --yes', () => {
      mergeAttempts += 1;
      const err = new Error('merge failed') as ThrowableError;
      err.stderr = '409 SHA does not match HEAD of source branch\n';
      throw err;
    });

    const result = await prMergeGitlab({ number: 43, repo: 'org/repo' });
    expectErr(result);
    expect(mergeAttempts).toBe(2); // the bound — not 1, not unbounded
    expect(result.code).toBe('gitlab_head_sha_moved');
    expect(result.code).not.toBe('glab_mr_merge_failed');
    expect(result.error).toContain('source branch moved');
  });

  // PAIRED test: MR !409 and its control MR !410. Same genuine non-sha failure,
  // differing only in IID. The pair is the proof — !410 alone would pass even
  // with the bug, and !409 alone could be dismissed as a quirk of that fixture.
  //
  // The bug: glab's error text echoes the request URL, which carries the MR IID
  // (`.../merge_requests/409/merge`). A bare /\b409\b/ matched the IID rather
  // than an HTTP status, so ANY failure on MR !409 was misclassified as a
  // stale-head race, retried, and reported as `gitlab_head_sha_moved`.
  for (const [iid, label] of [
    [409, 'MR !409 — IID collides with the HTTP status being matched'],
    [410, 'MR !410 — control, no collision'],
  ] as Array<[number, string]>) {
    test(`non-sha failure is fatal and correctly classified: ${label}`, async () => {
      let mergeAttempts = 0;
      onExec(
        `glab api projects/org%2Frepo/merge_requests/${String(iid)}`,
        JSON.stringify({
          iid,
          state: 'opened',
          source_branch: 'feature/conflict',
          target_branch: 'main',
          web_url: `https://gitlab.com/org/repo/-/merge_requests/${String(iid)}`,
          labels: [],
          diff_refs: { head_sha: `head${String(iid)}aaaa` },
          merge_commit_sha: null,
        }),
      );
      onExec(`glab mr merge ${String(iid)} --squash --remove-source-branch --yes`, () => {
        mergeAttempts += 1;
        const err = new Error('merge failed') as ThrowableError;
        // Verbatim glab shape: the URL echoes the IID, and the real status is 405.
        err.stderr =
          'All attempts fail:\n#1: PUT https://gitlab.com/api/v4/projects/org%2Frepo/' +
          `merge_requests/${String(iid)}/merge: 405 {message: Method Not Allowed}\n`;
        throw err;
      });

      const result = await prMergeGitlab({ number: iid, repo: 'org/repo' });
      expectErr(result);
      // Must be the genuine failure, NOT a stale-head misclassification.
      expect(result.code).toBe('glab_mr_merge_failed');
      expect(result.code).not.toBe('gitlab_head_sha_moved');
      // And it must not have burned a retry on a non-race.
      expect(mergeAttempts).toBe(1);
    });
  }

  test('a real 409 status IS still classified as a stale-head race', async () => {
    // The other side of the fix: tightening the matcher must not stop it
    // recognising a genuine 409, which glab renders as `: 409 {message: ...}`.
    let mergeAttempts = 0;
    let mrReads = 0;
    onExec('glab api projects/org%2Frepo/merge_requests/50', () => {
      mrReads += 1;
      return JSON.stringify({
        iid: 50,
        state: mrReads >= 3 ? 'merged' : 'opened',
        source_branch: 'feature/moving',
        target_branch: 'main',
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/50',
        labels: [],
        diff_refs: { head_sha: `head50v${String(mrReads)}` },
        merge_commit_sha: mrReads >= 3 ? 'merged50' : null,
      });
    });
    onExec('glab mr merge 50 --squash --remove-source-branch --yes', () => {
      mergeAttempts += 1;
      if (mergeAttempts === 1) {
        const err = new Error('merge failed') as ThrowableError;
        // Status position: `409 {` — note the IID here is 50, so the ONLY 409
        // present is the genuine status.
        err.stderr =
          'All attempts fail:\n#1: PUT https://gitlab.com/api/v4/projects/org%2Frepo/' +
          'merge_requests/50/merge: 409 {message: something about the head}\n';
        throw err;
      }
      return '';
    });

    const result = await prMergeGitlab({ number: 50, repo: 'org/repo' });
    expectOk(result);
    expect(mergeAttempts).toBe(2); // retried, as a real race should be
  });

  test('a non-sha merge failure is fatal — no retry', async () => {
    let mergeAttempts = 0;
    onExec(
      'glab api projects/org%2Frepo/merge_requests/42',
      JSON.stringify({
        iid: 42,
        state: 'opened',
        source_branch: 'feature/conflict',
        target_branch: 'main',
        web_url: 'https://gitlab.com/org/repo/-/merge_requests/42',
        labels: [],
        diff_refs: { head_sha: 'head42aaaaaa' },
        merge_commit_sha: null,
      }),
    );
    onExec('glab mr merge 42 --squash --remove-source-branch --yes', () => {
      mergeAttempts += 1;
      const err = new Error('merge failed') as ThrowableError;
      err.stderr = 'merge request has conflicts\n';
      throw err;
    });

    const result = await prMergeGitlab({ number: 42, repo: 'org/repo' });
    expectErr(result);
    expect(result.code).toBe('glab_mr_merge_failed');
    expect(mergeAttempts).toBe(1);
  });

  test('deep 5-segment nested group — encodes path and still passes --sha', async () => {
    // The reported repro (#486): a deeply nested group. A 2-level repo can pass
    // while this fails, which is what made the defect look intermittent.
    const deep = 'analogicdev/internal/tools/blueshift/site-interpreters/rhel9';
    const encoded =
      'analogicdev%2Finternal%2Ftools%2Fblueshift%2Fsite-interpreters%2Frhel9';

    onExec('glab mr merge 4 --squash --remove-source-branch --yes', '');
    onExec(
      `glab api projects/${encoded}/merge_requests/4`,
      JSON.stringify({
        iid: 4,
        state: 'merged',
        source_branch: 'feature/deep',
        target_branch: 'main',
        web_url: `https://gitlab.com/${deep}/-/merge_requests/4`,
        labels: [],
        sha: 'deep4headsha',
        merge_commit_sha: 'deep4merge',
      }),
    );

    const result = await prMergeGitlab({ number: 4, repo: deep });
    expectOk(result);

    // Every path segment percent-encoded — the whole slug, not just the first.
    const apiCall = findCall('glab api projects/');
    expect(apiCall).toContain(encoded);
    expect(apiCall).not.toContain(`projects/${deep}`);

    const mergeCall = findCall('glab mr merge 4');
    expect(mergeCall).toContain("--sha 'deep4headsha'");
    expect(mergeCall).toContain(`-R '${deep}'`);
  });
});
