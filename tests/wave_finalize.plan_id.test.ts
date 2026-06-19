// Story 2.2 (#363) — title-pattern pinning: `wave_finalize` now assembles the
// kahuna→target MR title as `plan(#<plan_id>): <slug> — kahuna to <target>`.
//
// Thin, focused companion to `tests/wave_finalize.test.ts`. The main suite
// covers the full dispatch matrix (schema, idempotency, GitHub/GitLab happy
// paths, path containment, body assembly). Here we pin the AC-2 title
// contract under the new `plan_id` parameter name.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import {
  installChildProcessMock,
  onExec,
  resetExecMock,
  execCalls,
} from '../lib/test-support/mock-child-process.ts';

installChildProcessMock();

const { default: handler } = await import('../handlers/wave_finalize.ts');

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

let tmpRoot: string = '';

function makeTmpRoot(): string {
  return `/tmp/wave-finalize-plan-id-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

async function writeArtifact(root: string, relPath: string, content: string): Promise<void> {
  await Bun.write(join(root, relPath), content);
}

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
  tmpRoot = makeTmpRoot();
  onExec('git remote get-url origin', () => 'git@github.com:o/r.git');
});

afterEach(() => {
  resetExecMock();
});

describe('wave_finalize plan_id title pattern', () => {
  // AC-1: schema accepts plan_id (positive case — the parse succeeds and the
  // handler proceeds to MR creation).
  test('accepts plan_id and creates MR with plan(#N): <slug> — kahuna to <target>', async () => {
    await writeArtifact(tmpRoot, 'wave-1/flight-1/issue-5/results.md', 'done');

    mockGithubCreate(555, 'kahuna/77-docmancer-portal');

    const result = await handler.execute({
      plan_id: 77,
      kahuna_branch: 'kahuna/77-docmancer-portal',
      body_artifacts_dir: tmpRoot,
    });
    const data = parseResult(result);
    expect(data.ok).toBe(true);
    expect(data.created).toBe(true);

    const createCall = execCalls().find(c => c.includes("'pr' 'create'"));
    expect(createCall).toBeDefined();
    expect(createCall).toContain("'--title' 'plan(#77): docmancer-portal — kahuna to main'");
  });

  // AC-2: title uses explicit target_branch (not hard-coded to 'main') and
  // the `plan(#N):` prefix is preserved.
  test('title honors explicit target_branch under the plan(#N) prefix', async () => {
    await writeArtifact(tmpRoot, 'wave-1/flight-1/issue-5/results.md', 'done');

    mockGithubCreate(555, 'kahuna/99-foo', 'release/v2');

    await handler.execute({
      plan_id: 99,
      kahuna_branch: 'kahuna/99-foo',
      target_branch: 'release/v2',
      body_artifacts_dir: tmpRoot,
    });

    const createCall = execCalls().find(c => c.includes("'pr' 'create'"));
    expect(createCall).toBeDefined();
    expect(createCall as string).toContain("'--title' 'plan(#99): foo — kahuna to release/v2'");
  });

  // AC-4 regression guard: the legacy `epic(#N):` prefix must not be emitted.
  test('no longer emits the legacy epic(#N) title prefix', async () => {
    await writeArtifact(tmpRoot, 'wave-1/flight-1/issue-5/results.md', 'done');

    mockGithubCreate(555, 'kahuna/42-foo');

    await handler.execute({
      plan_id: 42,
      kahuna_branch: 'kahuna/42-foo',
      body_artifacts_dir: tmpRoot,
    });

    const createCall = execCalls().find(c => c.includes("'pr' 'create'"));
    expect(createCall).toBeDefined();
    expect(createCall as string).not.toContain('epic(#');
  });

  // AC-4 schema: legacy `epic_id` arg must fail validation cleanly.
  test('schema rejects legacy epic_id parameter', async () => {
    const result = await handler.execute({
      epic_id: 42,
      kahuna_branch: 'kahuna/42-foo',
      body_artifacts_dir: tmpRoot,
    });
    const data = parseResult(result);
    expect(data.ok).toBe(false);
    expect(data.error as string).toContain('plan_id');
  });
});
