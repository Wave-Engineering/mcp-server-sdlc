import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { installChildProcessMock, onExec, resetExecMock, execCalls, execCallsDetailed } from '../lib/test-support/mock-child-process.ts';
// Intentionally NOT importing from 'fs' — sibling test files partially mock
// 'fs' (only writeFileSync exposed), and Bun's mock.module leaks across the
// suite. Test setup uses Bun native APIs instead. See lesson_mcp_gotchas.md §6.
//
// Story 2.23 (#317): wave_finalize is now a thin dispatcher over
// `getAdapter().findExistingPr` + `.prCreate`. We mock child_process globally
// so both the top-level `detectPlatform()` + adapter subprocess calls route
// through the same registry. Argv assertions use the `runArgv` shell-escape
// style (each token single-quoted) — see `lib/shared/shell-escape.ts`.

installChildProcessMock();

let currentPlatform: 'github' | 'gitlab' = 'github';

const { default: handler, assembleBody } = await import('../handlers/wave_finalize.ts');

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

// --- tmp artifacts helpers ---
// Each test gets a unique tmpRoot path. We do NOT pre-create the directory;
// Bun.write creates parent dirs automatically when the first artifact lands.
// Tests that don't write any artifacts simply leave tmpRoot non-existent —
// the handler's safeScan path tolerates that.
let tmpRoot: string = '';

function makeTmpRoot(): string {
  return `/tmp/wave-finalize-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

async function writeArtifact(root: string, relPath: string, content: string): Promise<void> {
  await Bun.write(join(root, relPath), content);
}

// Helper: register the canonical mocks for a GitHub happy-path PR creation.
// Mocks both the idempotency lookup (`gh pr list`), the create step
// (`gh pr create`), the post-create view (`gh pr view <N> --json ...`), and
// the local branch-on-remote probe.
function mockGithubCreate(prNumber: number, headRef: string, baseRef = 'main') {
  const url = `https://github.com/o/r/pull/${prNumber}`;
  onExec('gh pr list', '[]');
  onExec("'pr' 'create'", url);
  onExec(`'pr' 'view' '${prNumber}'`, JSON.stringify({
    number: prNumber, url, state: 'OPEN', headRefName: headRef, baseRefName: baseRef,
  }));
  onExec('ls-remote', `abc123\trefs/heads/${headRef}`);
}

beforeEach(() => {
  resetExecMock();
  currentPlatform = 'github';
  tmpRoot = makeTmpRoot();
  onExec(
    'git remote get-url origin',
    () => currentPlatform === 'gitlab'
      ? 'git@gitlab.com:o/r.git'
      : 'git@github.com:o/r.git',
  );
  // #472: target_branch now resolves to the LIVE default branch when omitted
  // (previously a static zod .default('main')). Stub both platforms' default
  // lookup to 'main' so the existing "default → main" assertions still hold.
  // GitHub: `gh repo view --json defaultBranchRef ...` (runArgv-escaped, matched
  // on the unique field token). GitLab: `glab api projects/:id`.
  onExec('defaultBranchRef', 'main');
  // Quote-bounded token so this matches ONLY `glab api projects/:id` (the
  // default-branch resolve) and NOT `projects/:id/merge_requests?...` (the
  // prCreate post-create lookup, which uses the same `:id` placeholder).
  onExec("'projects/:id'", JSON.stringify({ default_branch: 'main' }));
});

afterEach(() => {
  resetExecMock();
  // Tmp files in /tmp are reaped by the OS; explicit cleanup intentionally
  // skipped to avoid depending on fs.rmSync (mock leakage risk).
});

describe('wave_finalize handler', () => {
  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('wave_finalize');
    expect(typeof handler.execute).toBe('function');
  });

  // --- schema validation ---
  test('schema rejects missing plan_id', async () => {
    const result = await handler.execute({
      kahuna_branch: 'kahuna/42-foo',
    });
    const data = parseResult(result);
    expect(data.ok).toBe(false);
    expect(data.error as string).toContain('plan_id');
  });

  test('schema rejects non-positive plan_id', async () => {
    const result = await handler.execute({
      plan_id: 0,
      kahuna_branch: 'kahuna/42-foo',
    });
    const data = parseResult(result);
    expect(data.ok).toBe(false);
  });

  test('schema rejects missing kahuna_branch', async () => {
    const result = await handler.execute({ plan_id: 42 });
    const data = parseResult(result);
    expect(data.ok).toBe(false);
  });

  test('target_branch defaults to main', async () => {
    onExec('gh pr list', JSON.stringify([{
      number: 99, url: 'https://github.com/o/r/pull/99',
      state: 'OPEN', headRefName: 'kahuna/42-foo', baseRefName: 'main', title: 't',
    }]));
    onExec('ls-remote', 'abc123\trefs/heads/kahuna/42-foo');

    const result = await handler.execute({
      plan_id: 42,
      kahuna_branch: 'kahuna/42-foo',
      body_artifacts_dir: tmpRoot,
    });
    const data = parseResult(result);
    expect(data.ok).toBe(true);
    // gh pr list was called with --base main (default). The adapter
    // validates head/base against a strict charset and emits unquoted argv.
    const listCall = execCalls().find(c => c.includes('gh pr list'));
    expect(listCall).toBeDefined();
    expect(listCall).toContain('--base main');
  });

  // --- error: kahuna_branch_not_found ---
  test('returns kahuna_branch_not_found when neither an open MR nor the branch exists', async () => {
    onExec('gh pr list', '[]'); // no existing PR
    onExec('ls-remote', ''); // branch absent

    const result = await handler.execute({
      plan_id: 42,
      kahuna_branch: 'kahuna/42-nonexistent',
      body_artifacts_dir: tmpRoot,
    });
    const data = parseResult(result);
    expect(data.ok).toBe(false);
    expect(data.error).toBe('kahuna_branch_not_found');
  });

  // --- idempotency edge case: MR open but branch deleted post-merge-attempt ---
  test('returns existing open MR even when the kahuna branch has been deleted', async () => {
    await writeArtifact(tmpRoot, 'wave-1/flight-1/issue-5/results.md', 'done');

    onExec('gh pr list', JSON.stringify([{
      number: 88, url: 'https://github.com/o/r/pull/88',
      state: 'OPEN', headRefName: 'kahuna/42-foo', baseRefName: 'main', title: 't',
    }]));
    // branch gone — should NOT matter since MR is found first
    onExec('ls-remote', '');

    const result = await handler.execute({
      plan_id: 42,
      kahuna_branch: 'kahuna/42-foo',
      body_artifacts_dir: tmpRoot,
    });
    const data = parseResult(result);
    expect(data.ok).toBe(true);
    expect(data.created).toBe(false);
    expect(data.number).toBe(88);
  });

  // --- error: no_artifacts ---
  test('returns no_artifacts when artifact tree has no flight results', async () => {
    onExec('gh pr list', '[]');
    onExec('ls-remote', 'abc123\trefs/heads/kahuna/42-foo');

    const result = await handler.execute({
      plan_id: 42,
      kahuna_branch: 'kahuna/42-foo',
      body_artifacts_dir: tmpRoot, // empty directory
    });
    const data = parseResult(result);
    expect(data.ok).toBe(false);
    expect(data.error).toBe('no_artifacts');
  });

  test('no_artifacts even when wave-* dirs exist but no flights', async () => {
    await Bun.write(join(tmpRoot, 'wave-1', 'README.md'), 'no flights yet');

    onExec('gh pr list', '[]');
    onExec('ls-remote', 'abc123\trefs/heads/kahuna/42-foo');

    const result = await handler.execute({
      plan_id: 42,
      kahuna_branch: 'kahuna/42-foo',
      body_artifacts_dir: tmpRoot,
    });
    const data = parseResult(result);
    expect(data.ok).toBe(false);
    expect(data.error).toBe('no_artifacts');
  });

  // --- idempotency ---
  test('returns existing PR with created: false when one already exists', async () => {
    await writeArtifact(tmpRoot, 'wave-1/flight-1/issue-5/results.md',
      '# results\n\n- Added widget\nPR: https://github.com/o/r/pull/100\n');

    onExec('gh pr list', JSON.stringify([{
      number: 88, url: 'https://github.com/o/r/pull/88',
      state: 'OPEN', headRefName: 'kahuna/42-foo', baseRefName: 'main', title: 't',
    }]));

    const result = await handler.execute({
      plan_id: 42,
      kahuna_branch: 'kahuna/42-foo',
      body_artifacts_dir: tmpRoot,
    });
    const data = parseResult(result);
    expect(data.ok).toBe(true);
    expect(data.created).toBe(false);
    expect(data.number).toBe(88);
    expect(data.url).toBe('https://github.com/o/r/pull/88');
    expect(typeof data.body_sha).toBe('string');
    expect((data.body_sha as string).length).toBe(64); // SHA-256 hex
  });

  test('idempotent: does not call gh pr create when an existing PR is found', async () => {
    await writeArtifact(tmpRoot, 'wave-1/flight-1/issue-5/results.md', 'done');

    onExec('gh pr list', JSON.stringify([{
      number: 88, url: 'https://github.com/o/r/pull/88',
      state: 'OPEN', headRefName: 'kahuna/42-foo', baseRefName: 'main', title: 't',
    }]));

    await handler.execute({
      plan_id: 42,
      kahuna_branch: 'kahuna/42-foo',
      body_artifacts_dir: tmpRoot,
    });

    expect(execCalls().some(c => c.includes("'pr' 'create'"))).toBe(false);
  });

  // --- happy path: github ---
  test('github happy path: creates PR with assembled body and returns body_sha', async () => {
    await writeArtifact(tmpRoot, 'wave-1/flight-1/issue-5/results.md',
      '# Results\n\nAdded widget.\nPR: https://github.com/o/r/pull/100\n');
    await writeArtifact(tmpRoot, 'wave-1/flight-1/issue-6/results.md',
      '# Results\n\nFixed bug.\nPR: https://github.com/o/r/pull/101\n');

    mockGithubCreate(555, 'kahuna/42-wave-status-cli');

    const result = await handler.execute({
      plan_id: 42,
      kahuna_branch: 'kahuna/42-wave-status-cli',
      body_artifacts_dir: tmpRoot,
    });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.created).toBe(true);
    expect(data.number).toBe(555);
    expect(data.url).toBe('https://github.com/o/r/pull/555');
    expect(data.state).toBe('open');
    expect(typeof data.body_sha).toBe('string');
    expect((data.body_sha as string).length).toBe(64);
  });

  test('#453: handler threads `root` into BOTH the find and create PR subprocess cwd', async () => {
    // The wave-status read + branch probe were already rooted; this pins that the PR
    // find/create subprocesses ALSO run in `root`, not the session project (finding #8).
    await writeArtifact(tmpRoot, 'wave-1/flight-1/issue-5/results.md',
      '# Results\n\nAdded widget.\nPR: https://github.com/o/r/pull/100\n');
    mockGithubCreate(555, 'kahuna/42-foo');

    const result = await handler.execute({
      plan_id: 42,
      kahuna_branch: 'kahuna/42-foo',
      body_artifacts_dir: tmpRoot,
      root: tmpRoot, // the wave's target repo root
    });
    const data = parseResult(result);
    expect(data.ok).toBe(true);
    expect(data.created).toBe(true);

    // findExistingPr (`gh pr list`) and prCreate (`'pr' 'create'`) must both have run with cwd=root.
    const findIdx = execCalls().findIndex((c) => c.includes('gh pr list'));
    const createIdx = execCalls().findIndex((c) => c.includes("'pr' 'create'"));
    expect(findIdx).toBeGreaterThanOrEqual(0);
    expect(createIdx).toBeGreaterThanOrEqual(0);
    expect((execCallsDetailed()[findIdx].opts as { cwd?: string } | undefined)?.cwd).toBe(tmpRoot);
    expect((execCallsDetailed()[createIdx].opts as { cwd?: string } | undefined)?.cwd).toBe(tmpRoot);
  });

  test('title uses plan(#N): <slug> — kahuna to <target_branch>', async () => {
    await writeArtifact(tmpRoot, 'wave-1/flight-1/issue-5/results.md', 'done');

    mockGithubCreate(555, 'kahuna/42-wave-status-cli');

    await handler.execute({
      plan_id: 42,
      kahuna_branch: 'kahuna/42-wave-status-cli',
      body_artifacts_dir: tmpRoot,
    });

    const createCall = execCalls().find(c => c.includes("'pr' 'create'"));
    expect(createCall).toBeDefined();
    expect(createCall).toContain("'--title' 'plan(#42): wave-status-cli — kahuna to main'");
  });

  test('title uses explicit target_branch when provided', async () => {
    await writeArtifact(tmpRoot, 'wave-1/flight-1/issue-5/results.md', 'done');

    mockGithubCreate(555, 'kahuna/42-foo', 'release/v2');

    await handler.execute({
      plan_id: 42,
      kahuna_branch: 'kahuna/42-foo',
      target_branch: 'release/v2',
      body_artifacts_dir: tmpRoot,
    });

    const createCall = execCalls().find(c => c.includes("'pr' 'create'"));
    expect(createCall).toBeDefined();
    expect(createCall as string).toContain('kahuna to release/v2');
    expect(createCall as string).toContain("'--base' 'release/v2'");
  });

  // --- body assembly (tests the exported assembleBody directly) ---
  test('body assembles per-flight bullets with issue IDs and PR links from results.md', async () => {
    await writeArtifact(tmpRoot, 'wave-1/flight-1/issue-5/results.md',
      'Adds widget component.\nPR: https://github.com/o/r/pull/100\n');
    await writeArtifact(tmpRoot, 'wave-1/flight-2/issue-6/results.md',
      'Fixes navigation crash.\nhttps://github.com/o/r/pull/101\n');

    const result = await assembleBody(tmpRoot, 42, 'kahuna/42-foo', 'main');

    expect(result.flightCount).toBe(2);
    expect(result.issueCount).toBe(2);
    expect(result.body).toContain('Epic #42');
    expect(result.body).toContain('wave-1');
    expect(result.body).toContain('flight-1');
    expect(result.body).toContain('flight-2');
    expect(result.body).toContain('Issue #5');
    expect(result.body).toContain('Issue #6');
    expect(result.body).toContain('https://github.com/o/r/pull/100');
    expect(result.body).toContain('https://github.com/o/r/pull/101');
    expect(result.body).toContain('Adds widget component');
    expect(result.body).toContain('Fixes navigation crash');
  });

  test('body assembly falls back to flight-level merge-report.md for MR URL when results.md lacks one', async () => {
    await writeArtifact(tmpRoot, 'wave-1/flight-1/issue-5/results.md',
      'Adds widget component.\n(no URL here)\n');
    await writeArtifact(tmpRoot, 'wave-1/flight-1/merge-report.md',
      '# Merge Report\n\n- issue-5 landed: https://github.com/o/r/pull/100 (CI green, direct squash)\n');

    const result = await assembleBody(tmpRoot, 42, 'kahuna/42-foo', 'main');

    expect(result.body).toContain('https://github.com/o/r/pull/100');
  });

  test('body assembly supports fallback flat layout: flight-*/results.md (no issue-* dir)', async () => {
    await writeArtifact(tmpRoot, 'wave-1/flight-1/results.md',
      'Combined flight summary.\nPR: https://github.com/o/r/pull/200\n');

    const result = await assembleBody(tmpRoot, 42, 'kahuna/42-foo', 'main');

    expect(result.issueCount).toBe(1);
    expect(result.body).toContain('Combined flight summary');
    expect(result.body).toContain('https://github.com/o/r/pull/200');
  });

  test('body assembly returns issueCount=0 for an empty artifact tree', async () => {
    const result = await assembleBody(tmpRoot, 42, 'kahuna/42-foo', 'main');
    expect(result.issueCount).toBe(0);
    expect(result.flightCount).toBe(0);
    expect(result.body.length).toBeGreaterThan(0);
  });

  // --- body_sha determinism ---
  test('body_sha is deterministic — same artifacts produce the same hash', async () => {
    await writeArtifact(tmpRoot, 'wave-1/flight-1/issue-5/results.md', 'Summary A\nPR: https://github.com/o/r/pull/100');
    await writeArtifact(tmpRoot, 'wave-1/flight-1/issue-6/results.md', 'Summary B\nPR: https://github.com/o/r/pull/101');

    onExec('gh pr list', JSON.stringify([{
      number: 1, url: 'https://github.com/o/r/pull/1',
      state: 'OPEN', headRefName: 'kahuna/42-foo', baseRefName: 'main', title: 't',
    }]));

    const r1 = parseResult(await handler.execute({
      plan_id: 42,
      kahuna_branch: 'kahuna/42-foo',
      body_artifacts_dir: tmpRoot,
    }));
    const r2 = parseResult(await handler.execute({
      plan_id: 42,
      kahuna_branch: 'kahuna/42-foo',
      body_artifacts_dir: tmpRoot,
    }));

    expect(r1.body_sha).toBe(r2.body_sha);
    expect((r1.body_sha as string).length).toBe(64);
  });

  // --- default body_artifacts_dir derivation ---
  test('default body_artifacts_dir derives from kahuna_branch slug', async () => {
    onExec('gh pr list', '[]');
    onExec('ls-remote', 'abc\trefs/heads/kahuna/42-wave-status-cli');

    const result = await handler.execute({
      plan_id: 42,
      kahuna_branch: 'kahuna/42-wave-status-cli',
      // body_artifacts_dir omitted — defaults to /tmp/wavemachine/42-wave-status-cli
    });
    const data = parseResult(result);
    // Directory doesn't exist → no artifacts
    expect(data.ok).toBe(false);
    expect(data.error).toBe('no_artifacts');
  });

  // --- gitlab happy path ---
  test('gitlab happy path: creates MR with assembled body', async () => {
    currentPlatform = 'gitlab';
    await writeArtifact(tmpRoot, 'wave-1/flight-1/issue-5/results.md',
      'Done.\nMR: https://gitlab.com/o/r/-/merge_requests/100\n');

    // Post-create lookup match — registered FIRST so prCreateGitlab's
    // `glab api projects/.../merge_requests?source_branch=...` call doesn't
    // fall through to the broader pre-create idempotency mock below (#383).
    onExec(
      'source_branch=kahuna%2F42-foo&state=opened',
      JSON.stringify([{
        iid: 555,
        web_url: 'https://gitlab.com/o/r/-/merge_requests/555',
        state: 'opened',
        source_branch: 'kahuna/42-foo',
        target_branch: 'main',
      }]),
    );
    // Pre-create idempotency check (findExistingPr) — empty array.
    onExec('glab api projects/o%2Fr/merge_requests', JSON.stringify([]));
    onExec("'mr' 'create'", '');
    onExec('ls-remote', 'abc123\trefs/heads/kahuna/42-foo');

    const result = await handler.execute({
      plan_id: 42,
      kahuna_branch: 'kahuna/42-foo',
      body_artifacts_dir: tmpRoot,
    });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.created).toBe(true);
    expect(data.number).toBe(555);
    expect(data.url).toBe('https://gitlab.com/o/r/-/merge_requests/555');
  });

  test('gitlab idempotency: returns existing MR when one already exists', async () => {
    currentPlatform = 'gitlab';
    await writeArtifact(tmpRoot, 'wave-1/flight-1/issue-5/results.md', 'done');

    onExec('glab api projects/o%2Fr/merge_requests', JSON.stringify([{
      iid: 77,
      web_url: 'https://gitlab.com/o/r/-/merge_requests/77',
      state: 'opened',
      source_branch: 'kahuna/42-foo',
      target_branch: 'main',
      title: 't',
      description: null,
      labels: [],
    }]));

    const result = await handler.execute({
      plan_id: 42,
      kahuna_branch: 'kahuna/42-foo',
      body_artifacts_dir: tmpRoot,
    });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.created).toBe(false);
    expect(data.number).toBe(77);
    expect(execCalls().some(c => c.includes("'mr' 'create'"))).toBe(false);
  });

  // --- path containment ---
  test('rejects body_artifacts_dir outside /tmp and project directory', async () => {
    const result = await handler.execute({
      plan_id: 42,
      kahuna_branch: 'kahuna/42-foo',
      body_artifacts_dir: '/etc',
    });
    const data = parseResult(result);
    expect(data.ok).toBe(false);
    expect(data.error as string).toContain('outside allowed roots');
  });

  test('accepts body_artifacts_dir under /tmp', async () => {
    await writeArtifact(tmpRoot, 'wave-1/flight-1/issue-5/results.md', 'done');
    mockGithubCreate(555, 'kahuna/42-foo');

    const result = await handler.execute({
      plan_id: 42,
      kahuna_branch: 'kahuna/42-foo',
      body_artifacts_dir: tmpRoot, // /tmp/wave-finalize-test-...
    });
    const data = parseResult(result);
    expect(data.ok).toBe(true);
  });

  test('rejects body_artifacts_dir with parent-directory escape', async () => {
    // resolve('/tmp/foo/../../etc') === '/etc', which is outside allowed roots.
    const result = await handler.execute({
      plan_id: 42,
      kahuna_branch: 'kahuna/42-foo',
      body_artifacts_dir: '/tmp/foo/../../etc',
    });
    const data = parseResult(result);
    expect(data.ok).toBe(false);
    expect(data.error as string).toContain('outside allowed roots');
  });

  // --- body_sha: empty when existing PR + no artifacts (post-cleanup) ---
  test('body_sha is empty string when existing MR returned and artifacts are gone', async () => {
    onExec('gh pr list', JSON.stringify([{
      number: 88, url: 'https://github.com/o/r/pull/88',
      state: 'OPEN', headRefName: 'kahuna/42-foo', baseRefName: 'main', title: 't',
    }]));

    const result = await handler.execute({
      plan_id: 42,
      kahuna_branch: 'kahuna/42-foo',
      body_artifacts_dir: tmpRoot,
    });
    const data = parseResult(result);
    expect(data.ok).toBe(true);
    expect(data.created).toBe(false);
    expect(data.body_sha).toBe('');
  });

  // --- #415: durable-state fallback after wave_complete cleanup -------------
  // Regression coverage for `test_wave_finalize_after_wave_complete_cleanup`:
  // simulate the post-cleanup state where the wavebus dir is empty (every
  // results.md/merge-report.md has been wiped by `wave_complete`) but
  // `<project>/.claude/status/{phases-waves.json,state.json}` are intact.
  // The handler must re-derive the body from durable state instead of
  // returning `no_artifacts`.
  test('falls back to durable state when bus is empty (post-wave-complete cleanup)', async () => {
    // Project root with .claude/status/ wave-status fixtures, NO bus artifacts.
    const projectRoot = `/tmp/wave-finalize-state-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    await Bun.write(`${projectRoot}/.claude/status/phases-waves.json`, JSON.stringify({
      phases: [{
        waves: [
          { id: 'w1', issues: [{ number: 10 }, { number: 11 }] },
          { id: 'w2', issues: [{ number: 12 }] },
        ],
      }],
    }));
    await Bun.write(`${projectRoot}/.claude/status/state.json`, JSON.stringify({
      current_wave: 'w2',
      waves: {
        w1: { status: 'complete', mr_urls: {
          '10': 'https://github.com/o/r/pull/100',
          '11': 'https://github.com/o/r/pull/101',
        } },
        w2: { status: 'complete', mr_urls: {
          '12': 'https://github.com/o/r/pull/102',
        } },
      },
    }));

    mockGithubCreate(555, 'kahuna/42-foo');

    const result = await handler.execute({
      plan_id: 42,
      kahuna_branch: 'kahuna/42-foo',
      // bus tmpRoot is intentionally empty (cleanup happened).
      body_artifacts_dir: tmpRoot,
      // route the durable-state read at projectRoot.
      root: projectRoot,
    });
    const data = parseResult(result);

    // The fallback re-derived the body — finalize succeeded, no `no_artifacts`.
    expect(data.ok).toBe(true);
    expect(data.created).toBe(true);
    expect(data.number).toBe(555);
    expect(typeof data.body_sha).toBe('string');
    expect((data.body_sha as string).length).toBe(64);

    // The submitted body must contain one bullet per issue with the recorded
    // PR URL — verify by inspecting the `gh pr create` argv.
    const createCall = execCalls().find(c => c.includes("'pr' 'create'"));
    expect(createCall).toBeDefined();
    expect(createCall as string).toContain('Issue #10');
    expect(createCall as string).toContain('Issue #11');
    expect(createCall as string).toContain('Issue #12');
    expect(createCall as string).toContain('https://github.com/o/r/pull/100');
    expect(createCall as string).toContain('https://github.com/o/r/pull/101');
    expect(createCall as string).toContain('https://github.com/o/r/pull/102');
  });

  test('still returns no_artifacts when both bus AND durable state are empty', async () => {
    // Empty project root — no .claude/status/ at all.
    const emptyRoot = `/tmp/wave-finalize-empty-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    await Bun.write(`${emptyRoot}/.gitkeep`, '');

    onExec('gh pr list', '[]');
    onExec('ls-remote', 'abc123\trefs/heads/kahuna/42-foo');

    const result = await handler.execute({
      plan_id: 42,
      kahuna_branch: 'kahuna/42-foo',
      body_artifacts_dir: tmpRoot,
      root: emptyRoot,
    });
    const data = parseResult(result);
    expect(data.ok).toBe(false);
    expect(data.error).toBe('no_artifacts');
  });

  test('bus artifacts take precedence over durable state when both are present', async () => {
    // Bus has results from issue 99; durable state has issues 10/11/12.
    // The handler should use the bus body (issue 99 bullet), not the state.
    await writeArtifact(tmpRoot, 'wave-1/flight-1/issue-99/results.md',
      'Bus-sourced summary.\nPR: https://github.com/o/r/pull/999\n');

    const projectRoot = `/tmp/wave-finalize-prec-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    await Bun.write(`${projectRoot}/.claude/status/phases-waves.json`, JSON.stringify({
      phases: [{ waves: [{ id: 'w1', issues: [{ number: 10 }] }] }],
    }));
    await Bun.write(`${projectRoot}/.claude/status/state.json`, JSON.stringify({
      waves: { w1: { mr_urls: { '10': 'https://github.com/o/r/pull/100' } } },
    }));

    mockGithubCreate(555, 'kahuna/42-foo');

    await handler.execute({
      plan_id: 42,
      kahuna_branch: 'kahuna/42-foo',
      body_artifacts_dir: tmpRoot,
      root: projectRoot,
    });

    const createCall = execCalls().find(c => c.includes("'pr' 'create'"));
    expect(createCall).toBeDefined();
    expect(createCall as string).toContain('Issue #99');
    expect(createCall as string).toContain('https://github.com/o/r/pull/999');
    // Durable-state issue must NOT leak into the body.
    expect(createCall as string).not.toContain('Issue #10');
  });
});
