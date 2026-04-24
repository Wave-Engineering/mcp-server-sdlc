import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';

type Responder = string | (() => string);

let execRegistry: Array<{ match: string; respond: Responder }> = [];
let execCalls: string[] = [];

function mockExec(cmd: string): string {
  execCalls.push(cmd);
  for (const { match, respond } of execRegistry) {
    if (cmd.includes(match)) {
      return typeof respond === 'function' ? respond() : respond;
    }
  }
  throw new Error(`Unexpected exec call: ${cmd}`);
}

mock.module('child_process', () => ({
  execSync: (cmd: string, _opts?: unknown) => mockExec(cmd),
}));

let currentPlatform: 'github' | 'gitlab' = 'github';

const { default: handler, assembleBody } = await import('../handlers/wave_finalize.ts');

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

function onExec(match: string, respond: Responder) {
  execRegistry.push({ match, respond });
}

// --- tmp artifacts helpers ---
let tmpRoot: string = '';

function makeTmpDir(): string {
  const dir = `/tmp/wave-finalize-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeArtifact(root: string, relPath: string, content: string): void {
  const full = join(root, relPath);
  const dir = full.substring(0, full.lastIndexOf('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(full, content);
}

beforeEach(() => {
  execRegistry = [];
  execCalls = [];
  currentPlatform = 'github';
  tmpRoot = makeTmpDir();
  // detectPlatform() in lib/glab reads `git remote get-url origin`. Route it
  // through the shared exec mock so individual tests control the platform
  // via `currentPlatform`. Registered first so later test-specific matchers
  // (registered via onExec) take precedence for other commands.
  execRegistry.push({
    match: 'git remote get-url origin',
    respond: () => currentPlatform === 'gitlab'
      ? 'git@gitlab.com:o/r.git'
      : 'git@github.com:o/r.git',
  });
});

afterEach(() => {
  execRegistry = [];
  execCalls = [];
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // ignore cleanup failures
  }
});

describe('wave_finalize handler', () => {
  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('wave_finalize');
    expect(typeof handler.execute).toBe('function');
  });

  // --- schema validation ---
  test('schema rejects missing epic_id', async () => {
    const result = await handler.execute({
      kahuna_branch: 'kahuna/42-foo',
    });
    const data = parseResult(result);
    expect(data.ok).toBe(false);
    expect(data.error as string).toContain('epic_id');
  });

  test('schema rejects non-positive epic_id', async () => {
    const result = await handler.execute({
      epic_id: 0,
      kahuna_branch: 'kahuna/42-foo',
    });
    const data = parseResult(result);
    expect(data.ok).toBe(false);
  });

  test('schema rejects missing kahuna_branch', async () => {
    const result = await handler.execute({ epic_id: 42 });
    const data = parseResult(result);
    expect(data.ok).toBe(false);
  });

  test('target_branch defaults to main', async () => {
    onExec('git ls-remote', 'abc123\trefs/heads/kahuna/42-foo');
    onExec('gh pr list', JSON.stringify([{
      number: 99, url: 'https://github.com/o/r/pull/99',
      state: 'OPEN', headRefName: 'kahuna/42-foo', baseRefName: 'main',
    }]));

    const result = await handler.execute({
      epic_id: 42,
      kahuna_branch: 'kahuna/42-foo',
      body_artifacts_dir: tmpRoot,
    });
    const data = parseResult(result);
    expect(data.ok).toBe(true);
    // gh pr list was called with --base main (default)
    const listCall = execCalls.find(c => c.includes('gh pr list'));
    expect(listCall).toContain("--base 'main'");
  });

  // --- error: kahuna_branch_not_found ---
  test('returns kahuna_branch_not_found when neither an open MR nor the branch exists', async () => {
    onExec('gh pr list', '[]'); // no existing PR
    onExec('git ls-remote', ''); // branch absent

    const result = await handler.execute({
      epic_id: 42,
      kahuna_branch: 'kahuna/42-nonexistent',
      body_artifacts_dir: tmpRoot,
    });
    const data = parseResult(result);
    expect(data.ok).toBe(false);
    expect(data.error).toBe('kahuna_branch_not_found');
  });

  // --- idempotency edge case: MR open but branch deleted post-merge-attempt ---
  test('returns existing open MR even when the kahuna branch has been deleted', async () => {
    writeArtifact(tmpRoot, 'wave-1/flight-1/issue-5/results.md', 'done');

    onExec('gh pr list', JSON.stringify([{
      number: 88, url: 'https://github.com/o/r/pull/88',
      state: 'OPEN', headRefName: 'kahuna/42-foo', baseRefName: 'main',
    }]));
    onExec('git ls-remote', ''); // branch gone — should NOT matter since MR is found first

    const result = await handler.execute({
      epic_id: 42,
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
    onExec('git ls-remote', 'abc123\trefs/heads/kahuna/42-foo');
    onExec('gh pr list', '[]'); // no existing PR

    const result = await handler.execute({
      epic_id: 42,
      kahuna_branch: 'kahuna/42-foo',
      body_artifacts_dir: tmpRoot, // empty directory
    });
    const data = parseResult(result);
    expect(data.ok).toBe(false);
    expect(data.error).toBe('no_artifacts');
  });

  test('no_artifacts even when wave-* dirs exist but no flights', async () => {
    mkdirSync(join(tmpRoot, 'wave-1'), { recursive: true });

    onExec('git ls-remote', 'abc123\trefs/heads/kahuna/42-foo');
    onExec('gh pr list', '[]');

    const result = await handler.execute({
      epic_id: 42,
      kahuna_branch: 'kahuna/42-foo',
      body_artifacts_dir: tmpRoot,
    });
    const data = parseResult(result);
    expect(data.ok).toBe(false);
    expect(data.error).toBe('no_artifacts');
  });

  // --- idempotency ---
  test('returns existing PR with created: false when one already exists', async () => {
    // Artifacts present so we can compute body_sha for drift detection.
    writeArtifact(tmpRoot, 'wave-1/flight-1/issue-5/results.md',
      '# results\n\n- Added widget\nPR: https://github.com/o/r/pull/100\n');

    onExec('git ls-remote', 'abc123\trefs/heads/kahuna/42-foo');
    onExec('gh pr list', JSON.stringify([{
      number: 88, url: 'https://github.com/o/r/pull/88',
      state: 'OPEN', headRefName: 'kahuna/42-foo', baseRefName: 'main',
    }]));

    const result = await handler.execute({
      epic_id: 42,
      kahuna_branch: 'kahuna/42-foo',
      body_artifacts_dir: tmpRoot,
    });
    const data = parseResult(result);
    expect(data.ok).toBe(true);
    expect(data.created).toBe(false);
    expect(data.number).toBe(88);
    expect(data.url).toBe('https://github.com/o/r/pull/88');
    // body_sha computed from artifacts for drift comparison
    expect(typeof data.body_sha).toBe('string');
    expect((data.body_sha as string).length).toBe(64); // SHA-256 hex
  });

  test('idempotent: does not call gh pr create when an existing PR is found', async () => {
    writeArtifact(tmpRoot, 'wave-1/flight-1/issue-5/results.md', 'done');

    onExec('git ls-remote', 'abc123\trefs/heads/kahuna/42-foo');
    onExec('gh pr list', JSON.stringify([{
      number: 88, url: 'https://github.com/o/r/pull/88',
      state: 'OPEN', headRefName: 'kahuna/42-foo', baseRefName: 'main',
    }]));

    await handler.execute({
      epic_id: 42,
      kahuna_branch: 'kahuna/42-foo',
      body_artifacts_dir: tmpRoot,
    });

    expect(execCalls.some(c => c.includes('gh pr create'))).toBe(false);
  });

  // --- happy path: github ---
  test('github happy path: creates PR with assembled body and returns body_sha', async () => {
    writeArtifact(tmpRoot, 'wave-1/flight-1/issue-5/results.md',
      '# Results\n\nAdded widget.\nPR: https://github.com/o/r/pull/100\n');
    writeArtifact(tmpRoot, 'wave-1/flight-1/issue-6/results.md',
      '# Results\n\nFixed bug.\nPR: https://github.com/o/r/pull/101\n');

    onExec('git ls-remote', 'abc123\trefs/heads/kahuna/42-wave-status-cli');
    onExec('gh pr list', '[]');
    onExec('gh pr create', 'https://github.com/o/r/pull/555');

    const result = await handler.execute({
      epic_id: 42,
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

  test('title uses epic(#N): <slug> — kahuna to <target_branch>', async () => {
    writeArtifact(tmpRoot, 'wave-1/flight-1/issue-5/results.md', 'done');

    onExec('git ls-remote', 'abc123\trefs/heads/kahuna/42-wave-status-cli');
    onExec('gh pr list', '[]');
    onExec('gh pr create', 'https://github.com/o/r/pull/555');

    await handler.execute({
      epic_id: 42,
      kahuna_branch: 'kahuna/42-wave-status-cli',
      body_artifacts_dir: tmpRoot,
    });

    const createCall = execCalls.find(c => c.includes('gh pr create'));
    expect(createCall).toBeDefined();
    expect(createCall).toContain("--title 'epic(#42): wave-status-cli — kahuna to main'");
  });

  test('title uses explicit target_branch when provided', async () => {
    writeArtifact(tmpRoot, 'wave-1/flight-1/issue-5/results.md', 'done');

    onExec('git ls-remote', 'abc123\trefs/heads/kahuna/42-foo');
    onExec('gh pr list', '[]');
    onExec('gh pr create', 'https://github.com/o/r/pull/555');

    await handler.execute({
      epic_id: 42,
      kahuna_branch: 'kahuna/42-foo',
      target_branch: 'release/v2',
      body_artifacts_dir: tmpRoot,
    });

    const createCall = execCalls.find(c => c.includes('gh pr create'));
    expect(createCall).toContain("kahuna to release/v2");
    expect(createCall).toContain("--base 'release/v2'");
  });

  // --- body assembly (tests the exported assembleBody directly) ---
  test('body assembles per-flight bullets with issue IDs and PR links from results.md', async () => {
    writeArtifact(tmpRoot, 'wave-1/flight-1/issue-5/results.md',
      'Adds widget component.\nPR: https://github.com/o/r/pull/100\n');
    writeArtifact(tmpRoot, 'wave-1/flight-2/issue-6/results.md',
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
    writeArtifact(tmpRoot, 'wave-1/flight-1/issue-5/results.md',
      'Adds widget component.\n(no URL here)\n');
    writeArtifact(tmpRoot, 'wave-1/flight-1/merge-report.md',
      '# Merge Report\n\n- issue-5 landed: https://github.com/o/r/pull/100 (CI green, direct squash)\n');

    const result = await assembleBody(tmpRoot, 42, 'kahuna/42-foo', 'main');

    expect(result.body).toContain('https://github.com/o/r/pull/100');
  });

  test('body assembly supports fallback flat layout: flight-*/results.md (no issue-* dir)', async () => {
    writeArtifact(tmpRoot, 'wave-1/flight-1/results.md',
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
    // Body still has the header — non-empty by design (issueCount is the
    // sentinel for "had any content", not body.length).
    expect(result.body.length).toBeGreaterThan(0);
  });

  // --- body_sha determinism ---
  test('body_sha is deterministic — same artifacts produce the same hash', async () => {
    writeArtifact(tmpRoot, 'wave-1/flight-1/issue-5/results.md', 'Summary A\nPR: https://github.com/o/r/pull/100');
    writeArtifact(tmpRoot, 'wave-1/flight-1/issue-6/results.md', 'Summary B\nPR: https://github.com/o/r/pull/101');

    onExec('git ls-remote', 'abc123\trefs/heads/kahuna/42-foo');
    onExec('gh pr list', JSON.stringify([{
      number: 1, url: 'https://github.com/o/r/pull/1',
      state: 'OPEN', headRefName: 'kahuna/42-foo', baseRefName: 'main',
    }]));

    const r1 = parseResult(await handler.execute({
      epic_id: 42,
      kahuna_branch: 'kahuna/42-foo',
      body_artifacts_dir: tmpRoot,
    }));
    const r2 = parseResult(await handler.execute({
      epic_id: 42,
      kahuna_branch: 'kahuna/42-foo',
      body_artifacts_dir: tmpRoot,
    }));

    expect(r1.body_sha).toBe(r2.body_sha);
    expect((r1.body_sha as string).length).toBe(64);
  });

  // --- default body_artifacts_dir derivation ---
  test('default body_artifacts_dir derives from kahuna_branch slug', async () => {
    // Branch doesn't exist → path derivation not exercised; just confirm the
    // error path (no artifact dir created) still fires correctly.
    onExec('git ls-remote', 'abc\trefs/heads/kahuna/42-wave-status-cli');
    onExec('gh pr list', '[]');

    const result = await handler.execute({
      epic_id: 42,
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
    writeArtifact(tmpRoot, 'wave-1/flight-1/issue-5/results.md',
      'Done.\nMR: https://gitlab.com/o/r/-/merge_requests/100\n');

    onExec('git ls-remote', 'abc123\trefs/heads/kahuna/42-foo');
    onExec('glab mr list', '[]');
    onExec('glab mr create', '');
    onExec('glab mr view', JSON.stringify({
      iid: 555,
      web_url: 'https://gitlab.com/o/r/-/merge_requests/555',
      source_branch: 'kahuna/42-foo',
      target_branch: 'main',
    }));

    const result = await handler.execute({
      epic_id: 42,
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
    writeArtifact(tmpRoot, 'wave-1/flight-1/issue-5/results.md', 'done');

    onExec('git ls-remote', 'abc123\trefs/heads/kahuna/42-foo');
    onExec('glab mr list', JSON.stringify([{
      iid: 77,
      web_url: 'https://gitlab.com/o/r/-/merge_requests/77',
      state: 'opened',
      source_branch: 'kahuna/42-foo',
      target_branch: 'main',
    }]));

    const result = await handler.execute({
      epic_id: 42,
      kahuna_branch: 'kahuna/42-foo',
      body_artifacts_dir: tmpRoot,
    });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.created).toBe(false);
    expect(data.number).toBe(77);
    expect(execCalls.some(c => c.includes('glab mr create'))).toBe(false);
  });

  // --- path containment ---
  test('rejects body_artifacts_dir outside /tmp and project directory', async () => {
    const result = await handler.execute({
      epic_id: 42,
      kahuna_branch: 'kahuna/42-foo',
      body_artifacts_dir: '/etc',
    });
    const data = parseResult(result);
    expect(data.ok).toBe(false);
    expect(data.error as string).toContain('outside allowed roots');
  });

  test('accepts body_artifacts_dir under /tmp', async () => {
    writeArtifact(tmpRoot, 'wave-1/flight-1/issue-5/results.md', 'done');
    onExec('gh pr list', '[]');
    onExec('git ls-remote', 'abc\trefs/heads/kahuna/42-foo');
    onExec('gh pr create', 'https://github.com/o/r/pull/555');

    const result = await handler.execute({
      epic_id: 42,
      kahuna_branch: 'kahuna/42-foo',
      body_artifacts_dir: tmpRoot, // /tmp/wave-finalize-test-...
    });
    const data = parseResult(result);
    expect(data.ok).toBe(true);
  });

  test('rejects body_artifacts_dir with parent-directory escape', async () => {
    // resolve('/tmp/foo/../../etc') === '/etc', which is outside allowed roots.
    const result = await handler.execute({
      epic_id: 42,
      kahuna_branch: 'kahuna/42-foo',
      body_artifacts_dir: '/tmp/foo/../../etc',
    });
    const data = parseResult(result);
    expect(data.ok).toBe(false);
    expect(data.error as string).toContain('outside allowed roots');
  });

  // --- body_sha: empty when existing PR + no artifacts (post-cleanup) ---
  test('body_sha is empty string when existing MR returned and artifacts are gone', async () => {
    // Empty tmpRoot — no wave-* dirs at all
    onExec('gh pr list', JSON.stringify([{
      number: 88, url: 'https://github.com/o/r/pull/88',
      state: 'OPEN', headRefName: 'kahuna/42-foo', baseRefName: 'main',
    }]));

    const result = await handler.execute({
      epic_id: 42,
      kahuna_branch: 'kahuna/42-foo',
      body_artifacts_dir: tmpRoot,
    });
    const data = parseResult(result);
    expect(data.ok).toBe(true);
    expect(data.created).toBe(false);
    expect(data.body_sha).toBe('');
  });

  // --- shell escaping ---
  test('shell-escapes kahuna_branch and target_branch in all commands', async () => {
    writeArtifact(tmpRoot, 'wave-1/flight-1/issue-5/results.md', 'done');

    onExec('git ls-remote', 'abc\trefs/heads/kahuna/42-foo');
    onExec('gh pr list', '[]');
    onExec('gh pr create', 'https://github.com/o/r/pull/555');

    await handler.execute({
      epic_id: 42,
      kahuna_branch: "kahuna/42-has 'quotes'",
      target_branch: 'main',
      body_artifacts_dir: tmpRoot,
    });

    // Every command that uses these values should single-quote and escape.
    for (const c of execCalls) {
      if (c.includes("kahuna/42-has")) {
        expect(c).toContain(`'kahuna/42-has '\\''quotes'\\'''`);
      }
    }
  });
});
