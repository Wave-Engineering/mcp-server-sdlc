/**
 * Tests for `handlers/plan_load_dod.ts` — Plan DoD extraction handler.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  installChildProcessMock,
  onExec,
  resetExecMock,
  execCalls,
} from '../lib/test-support/mock-child-process.ts';

// Mock child_process registry — matched by substring so individual tests can
// install exec fixtures for `git remote`, `gh issue view`, `glab api projects/...`.
// The handler dispatches through getAdapter().fetchIssue(...), which under
// the hood execs `gh issue view` (GitHub) / `glab api projects/...` (GitLab).
installChildProcessMock();

const { default: handler } = await import('../handlers/plan_load_dod.ts');

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

const CANONICAL_PLAN_BODY = `# Plan: Payment System

## Plan-level Definition of Done

- [ ] All Phase deliverables complete
- [x] Architecture approved
- [ ] Documentation complete

## Phases

### Phase 1 — Foundation

Database schema and API scaffolding.

**DoD:**

- [ ] Schema migrations created [R-01]
- [ ] API endpoints stubbed [R-02]
- [x] README updated

### Phase 2 — Core Logic

Payment processing integration.

**DoD:**

- [ ] Stripe integration complete [R-03]
- [ ] Validation rules applied
- [ ] Error handling implemented

## References

Dev Spec: \`docs/specs/payment-system.md\`
Architecture: \`docs/arch/payments-overview.md\`
`;

const INVALID_PLAN_BODY = `# Plan: Broken

## Some Section

Content without required headings.
`;

describe('plan_load_dod handler', () => {
  beforeEach(resetExecMock);
  afterEach(resetExecMock);

  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('plan_load_dod');
    expect(typeof handler.execute).toBe('function');
  });

  test('parses canonical Plan body (golden path) — GitHub', async () => {
    onExec('git remote get-url origin', 'git@github.com:Wave-Engineering/mcp-server-sdlc.git');
    onExec('gh issue view 123', JSON.stringify({
      number: 123,
      title: 'Plan: Payment System',
      state: 'OPEN',
      body: CANONICAL_PLAN_BODY,
      labels: [],
    }));

    const result = await handler.execute({ plan_id: 123 });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.plan_id).toBe(123);
    expect(parsed.plan_title).toBe('Plan: Payment System');

    expect(parsed.plan_level_dod).toHaveLength(3);
    expect(parsed.plan_level_dod[0]).toEqual({
      checked: false,
      text: 'All Phase deliverables complete',
    });
    expect(parsed.plan_level_dod[1]).toEqual({
      checked: true,
      text: 'Architecture approved',
    });

    expect(parsed.phases).toHaveLength(2);
    expect(parsed.phases[0].phase_name).toBe('Foundation');
    expect(parsed.phases[0].items).toHaveLength(3);
    expect(parsed.phases[0].items[0]).toEqual({
      checked: false,
      text: 'Schema migrations created',
      ref: 'R-01',
    });

    expect(parsed.phases[1].phase_name).toBe('Core Logic');
    expect(parsed.phases[1].items).toHaveLength(3);

    expect(parsed.devspec_path).toBe('docs/specs/payment-system.md');
    expect(parsed.references).toHaveLength(2);
  });

  test('parses canonical Plan body (golden path) — GitLab', async () => {
    onExec('git remote get-url origin', 'git@gitlab.com:wave-eng/mcp-server-sdlc.git');
    onExec('glab api projects/wave-eng%2Fmcp-server-sdlc/issues/456', JSON.stringify({
      iid: 456,
      title: 'Plan: Payment System',
      state: 'opened',
      web_url: 'https://gitlab.com/wave-eng/mcp-server-sdlc/-/issues/456',
      description: CANONICAL_PLAN_BODY,
      labels: [],
    }));

    const result = await handler.execute({ plan_id: 456 });
    const parsed = parseResult(result);

    if (!parsed.ok) {
      console.log('GitLab test failed:', parsed);
    }
    expect(parsed.ok).toBe(true);
    expect(parsed.plan_id).toBe(456);
    expect(parsed.plan_title).toBe('Plan: Payment System');
    expect(parsed.plan_level_dod).toHaveLength(3);
    expect(parsed.phases).toHaveLength(2);
    expect(parsed.devspec_path).toBe('docs/specs/payment-system.md');
  });

  test('extracts Plan-level DoD checkboxes with checked state', async () => {
    const bodyWithChecks = `
## Plan-level Definition of Done

- [x] Task 1 done
- [ ] Task 2 pending
- [X] Task 3 done uppercase

## Phases

### Phase 1 — Test

**DoD:**

- [ ] Item

## References

None
`;

    onExec('git remote get-url origin', 'origin\tgit@github.com:test/repo.git (fetch)');
    onExec('gh issue view 100', JSON.stringify({
      number: 100,
      title: 'Plan',
      state: 'OPEN',
      body: bodyWithChecks,
      labels: [],
    }));

    const result = await handler.execute({ plan_id: 100 });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.plan_level_dod).toHaveLength(3);
    expect(parsed.plan_level_dod[0].checked).toBe(true);
    expect(parsed.plan_level_dod[1].checked).toBe(false);
    expect(parsed.plan_level_dod[2].checked).toBe(true);
  });

  test('extracts per-Phase DoD with [R-XX] ref suffix', async () => {
    const bodyWithRefs = `
## Plan-level Definition of Done

- [ ] Done

## Phases

### Phase 1 — Test

**DoD:**

- [ ] Task A [R-01]
- [ ] Task B [R-10]
- [ ] Task C without ref

## References

None
`;

    onExec('git remote get-url origin', 'origin\tgit@github.com:test/repo.git (fetch)');
    onExec('gh issue view 100', JSON.stringify({
      number: 100,
      title: 'Plan',
      state: 'OPEN',
      body: bodyWithRefs,
      labels: [],
    }));

    const result = await handler.execute({ plan_id: 100 });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.phases[0].items).toHaveLength(3);
    expect(parsed.phases[0].items[0].ref).toBe('R-01');
    expect(parsed.phases[0].items[1].ref).toBe('R-10');
    expect(parsed.phases[0].items[2].ref).toBeUndefined();
  });

  test('extracts Dev Spec path from References', async () => {
    const bodyWithDevSpec = `
## Plan-level Definition of Done

- [ ] Done

## Phases

### Phase 1 — Test

**DoD:**

- [ ] Task

## References

Dev Spec: \`path/to/devspec.md\`
Other: \`other.md\`
`;

    onExec('git remote get-url origin', 'origin\tgit@github.com:test/repo.git (fetch)');
    onExec('gh issue view 100', JSON.stringify({
      number: 100,
      title: 'Plan',
      state: 'OPEN',
      body: bodyWithDevSpec,
      labels: [],
    }));

    const result = await handler.execute({ plan_id: 100 });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.devspec_path).toBe('path/to/devspec.md');
    expect(parsed.references).toHaveLength(2);
  });

  test('body missing required headings → plan_body_invalid', async () => {
    onExec('git remote get-url origin', 'origin\tgit@github.com:test/repo.git (fetch)');
    onExec('gh issue view 999', JSON.stringify({
      number: 999,
      title: 'Broken Plan',
      state: 'OPEN',
      body: INVALID_PLAN_BODY,
      labels: [],
    }));

    const result = await handler.execute({ plan_id: 999 });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('plan_body_invalid');
    expect(parsed.missing_headings).toBeDefined();
    expect(parsed.missing_headings.length).toBeGreaterThan(0);
  });

  test('nonexistent plan_id → plan_not_found (via adapter)', async () => {
    onExec('git remote get-url origin', 'origin\tgit@github.com:test/repo.git (fetch)');
    // Simulate gh issue view returning error (nonzero exit caught by adapter)
    onExec('gh issue view 404', ''); // Empty response will fail parse

    const result = await handler.execute({ plan_id: 404 });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(false);
    // The exact error code depends on adapter behavior; could be parse error or CLI error
    expect(parsed.error).toBeDefined();
  });

  test('handler dispatches to GitHub on github cwd', async () => {
    onExec('git remote get-url origin', 'origin\tgit@github.com:test/repo.git (fetch)');
    onExec('gh issue view 123', JSON.stringify({
      number: 123,
      title: 'Plan',
      state: 'OPEN',
      body: CANONICAL_PLAN_BODY,
      labels: [],
    }));

    await handler.execute({ plan_id: 123 });

    // Verify gh was called (not glab)
    const calls = execCalls();
    expect(calls.some(c => c.includes('gh issue view'))).toBe(true);
    expect(calls.some(c => c.includes('glab api'))).toBe(false);
  });

  test('handler dispatches to GitLab on gitlab cwd, no -F flag', async () => {
    onExec('git remote get-url origin', 'origin\tgit@gitlab.com:wave-eng/mcp-server-sdlc.git (fetch)');
    onExec('glab api projects/wave-eng%2Fmcp-server-sdlc/issues/456', JSON.stringify({
      iid: 456,
      title: 'Plan',
      state: 'opened',
      web_url: 'https://gitlab.com/wave-eng/mcp-server-sdlc/-/issues/456',
      description: CANONICAL_PLAN_BODY,
      labels: [],
    }));

    await handler.execute({ plan_id: 456 });

    // Verify glab was called (not gh), and no -F flag
    const calls = execCalls();
    expect(calls.some(c => c.includes('glab api'))).toBe(true);
    expect(calls.some(c => c.includes('gh issue view'))).toBe(false);
    expect(calls.some(c => c.includes(' -F '))).toBe(false);
  });

  // #405: the `repo` arg is validated by the shared repoOptionalSchema BEFORE
  // it reaches getAdapter()/adapter.fetchIssue() — the schema layer is the
  // first line of defence against shell metacharacters / path traversal
  // reaching the `glab api projects/<slug>/issues/N` subprocess string.
  describe('repo arg validation (#405)', () => {
    test('rejects shell metacharacters and never execs an adapter', async () => {
      const result = await handler.execute({ plan_id: 1, repo: 'foo;bar' });
      const parsed = parseResult(result);

      expect(parsed.ok).toBe(false);
      // AC: error messages match the shared REPO_SLUG_ERROR constant.
      expect(String(parsed.error)).toContain(
        'owner/repo or group/subgroup/.../repo format',
      );
      // The subprocess boundary is never reached — validation short-circuits.
      const calls = execCalls();
      expect(calls.some(c => c.includes('glab api'))).toBe(false);
      expect(calls.some(c => c.includes('gh issue view'))).toBe(false);
    });

    test('neutralizes a path-traversal-shaped slug via URL-encoding', async () => {
      // `.`/`-`/`_` are legal repo-name characters, so a dot-traversal slug
      // like `../../../etc/passwd` is FORMAT-valid and passes the slug regex —
      // the schema is a format validator, not a path sandbox. The traversal is
      // instead neutralized downstream: gitlab-api url-encodes the whole slug
      // so every `/` becomes `%2F` before it is concatenated into the
      // `glab api projects/<slug>/issues/N` string. No raw `../` ever reaches
      // the subprocess, so it cannot escape the projects/<id> path segment; the
      // bogus project id simply fails to resolve.
      onExec(
        'glab api projects/..%2F..%2F..%2Fetc%2Fpasswd/issues/1',
        '', // empty → adapter JSON-parse fails → ok:false, controlled path
      );

      const result = await handler.execute({
        plan_id: 1,
        repo: '../../../etc/passwd',
      });
      const parsed = parseResult(result);

      expect(parsed.ok).toBe(false);
      const calls = execCalls();
      // Encoding happened: separators are `%2F`, and the raw traversal
      // sequence `../` never appears in the exec'd command string.
      expect(calls.some(c => c.includes('%2F'))).toBe(true);
      expect(calls.some(c => c.includes('../'))).toBe(false);
    });

    test('rejects empty-string repo', async () => {
      const result = await handler.execute({ plan_id: 1, repo: '' });
      const parsed = parseResult(result);

      expect(parsed.ok).toBe(false);
      expect(String(parsed.error)).toContain(
        'owner/repo or group/subgroup/.../repo format',
      );
    });

    test('accepts valid GitLab nested-group repo and routes to glab', async () => {
      // A 3+ segment slug routes straight to the gitlab adapter (route.ts
      // inferPlatform), so no cwd detection is needed. parseSlugOpts splits at
      // the first `/`: owner=`analogicdev`, repo=`internal/tools/blueshift`;
      // projectPath url-encodes the full `owner/repo` path.
      onExec(
        'glab api projects/analogicdev%2Finternal%2Ftools%2Fblueshift/issues/7',
        JSON.stringify({
          iid: 7,
          title: 'Plan: Nested',
          state: 'opened',
          web_url:
            'https://gitlab.com/analogicdev/internal/tools/blueshift/-/issues/7',
          description: CANONICAL_PLAN_BODY,
          labels: [],
        }),
      );

      const result = await handler.execute({
        plan_id: 7,
        repo: 'analogicdev/internal/tools/blueshift',
      });
      const parsed = parseResult(result);

      expect(parsed.ok).toBe(true);
      expect(parsed.plan_id).toBe(7);
      const calls = execCalls();
      expect(calls.some(c => c.includes('glab api'))).toBe(true);
      expect(calls.some(c => c.includes('gh issue view'))).toBe(false);
    });
  });
});
