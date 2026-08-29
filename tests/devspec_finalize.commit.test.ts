import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  installChildProcessMock,
  setExecMock,
  resetExecMock,
  execCalls,
} from '../lib/test-support/mock-child-process.ts';
import { shellEscape } from '../lib/shared/shell-escape.ts';

// #458: devspec_finalize commits its doc writes on all-checks-pass. The commit
// path shells out to plain `git` via runArgv → child_process.execSync, so this
// suite installs the shared execSync mock at module top level (BEFORE the
// dynamic import of the handler) and asserts the exact git argv.
installChildProcessMock();

const { default: handler } = await import('../handlers/devspec_finalize.ts');

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

async function writeTempSpec(content: string): Promise<string> {
  const path = `/tmp/devspec-finalize-commit-${Date.now()}-${Math.floor(Math.random() * 1e9)}.md`;
  await Bun.write(path, content);
  return path;
}

/**
 * A dev spec that passes all 8 finalization checks — reused from the sibling
 * validation suite so the commit tests exercise the real all-pass path.
 */
const HAPPY_SPEC = `# Project X — Development Specification

## 5. Detailed Design

### 5.A Deliverables Manifest

| ID | Deliverable | Category | Tier | File Path | Produced In | Status | Notes |
|----|-------------|----------|------|-----------|-------------|--------|-------|
| DM-01 | README.md | Docs | 1 | \`README.md\` | Wave 1 | required | overview |
| DM-02 | Unified build system | Code | 1 | \`Makefile\` | Wave 1 | required | |
| DM-03 | CI/CD pipeline | Code | 1 | \`.github/workflows/ci.yml\` | Wave 1 | required | |
| DM-04 | Automated test suite | Test | 1 | \`tests/\` | Wave 1 | required | |
| DM-05 | Test results (JUnit XML) | Test | 1 | \`reports/junit.xml\` | Wave 1 | required | |
| DM-06 | Coverage report | Test | 1 | \`reports/coverage.xml\` | Wave 1 | required | |
| DM-07 | CHANGELOG | Docs | 1 | \`CHANGELOG.md\` | Wave 1 | required | |
| DM-08 | VRTM | Trace | 1 | N/A — because the project is a spike | Wave 3 | required | |
| DM-09 | Audience-facing doc (runbook) | Docs | 1 | \`docs/runbook.md\` | Wave 2 | required | |
| DM-10 | Manual test procedures document | Docs | 2 | \`docs/manual-tests.md\` | Wave 3 | required | triggered by MV items |

## 6. Test Plan

### 6.4 Manual Verification Procedures

| ID | Procedure | Pass Criteria | Req IDs |
|----|-----------|--------------|---------|
| MV-01 | Click the button | Dialog appears | R-01 |
| MV-02 | Submit empty form | Error shows | R-02 |

## 7. Definition of Done

- [ ] All Phase DoD checklists satisfied
- [ ] All deliverables from the Deliverables Manifest (Section 5.A) produced and verified

### 7.2 Dev Spec Finalization Checklist

- [ ] Every Tier 1 row has a file path or N/A
`;

/**
 * Responder for the shared execSync mock. Answers the git commands the commit
 * path issues; every argv token is single-quoted by runArgv/shellEscape, so we
 * strip quotes before substring-matching.
 */
function gitResponder(opts: { branch: string; staged: string[]; sha?: string }) {
  return (cmd: string): string => {
    const flat = cmd.replace(/'/g, '');
    if (flat.includes('git branch --show-current')) return `${opts.branch}\n`;
    if (flat.includes('git diff --cached --name-only')) return opts.staged.join('\n');
    if (flat.includes('git add')) return '';
    if (flat.includes('git commit')) return '';
    if (flat.includes('git rev-parse HEAD')) return `${opts.sha ?? 'deadbeefcafe0000'}\n`;
    return '';
  };
}

/** Recorded git commands with quoting stripped, for readable assertions. */
function flatCalls(): string[] {
  return execCalls().map(c => c.replace(/'/g, ''));
}

describe('devspec_finalize — commit-on-pass (#458)', () => {
  // Point CLAUDE_PROJECT_DIR at a clean empty temp dir so the depends_on check
  // finds no phases-waves.json and passes with "not yet written". The git
  // subprocess boundary is mocked, so this cwd is only read by the (real)
  // Bun.file spec/plan reads, never by an actual git invocation.
  const ORIGINAL_PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR;
  let emptyProjectDir = '';

  beforeEach(async () => {
    resetExecMock();
    setExecMock(() => '');
    emptyProjectDir = `/tmp/devspec-finalize-commit-empty-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    await Bun.write(`${emptyProjectDir}/.sentinel`, '');
    process.env.CLAUDE_PROJECT_DIR = emptyProjectDir;
  });

  afterEach(() => {
    resetExecMock();
    if (ORIGINAL_PROJECT_DIR === undefined) {
      delete process.env.CLAUDE_PROJECT_DIR;
    } else {
      process.env.CLAUDE_PROJECT_DIR = ORIGINAL_PROJECT_DIR;
    }
  });

  test('commits_on_pass — all checks pass + doc writes present → committed with bare subject', async () => {
    setExecMock(gitResponder({ branch: 'feature/458-devspec-commit', staged: ['docs/x-devspec.md'], sha: 'abc1234def' }));
    const path = await writeTempSpec(HAPPY_SPEC);

    const result = await handler.execute({ path, plan_id: 77 });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.passed).toBe(8);
    expect(parsed.ready_for_approval).toBe(true);
    expect(parsed.committed).toBe(true);
    expect(parsed.commit_sha).toBe('abc1234def');
    expect(parsed.files).toEqual(['docs/x-devspec.md']);
    expect(parsed.refused_reason).toBeNull();

    // Exact commit subject — bare, no slug suffix (#458). Assert on the
    // shell-escaped token so the substring cannot pass vacuously across quotes.
    const commitCall = execCalls().find(c => c.replace(/'/g, '').includes('git commit'));
    expect(commitCall).toBeDefined();
    expect(commitCall).toContain(shellEscape('docs(devspec): finalize Dev Spec for Plan #77'));
    // The spec path is staged and pathspec-limits the commit.
    expect(commitCall).toContain(shellEscape(path));
  });

  test('commits_on_pass — stages extra ledger/memory files passed via `files`', async () => {
    setExecMock(
      gitResponder({ branch: 'feature/458-x', staged: ['docs/x-devspec.md', '.sdlc/ledger.md'], sha: 'f00d' }),
    );
    const path = await writeTempSpec(HAPPY_SPEC);

    const result = await handler.execute({ path, plan_id: 12, files: ['/tmp/ledger.md'] });
    const parsed = parseResult(result);

    expect(parsed.committed).toBe(true);
    expect(parsed.files).toEqual(['docs/x-devspec.md', '.sdlc/ledger.md']);
    const addCall = execCalls().find(c => c.replace(/'/g, '').includes('git add'));
    expect(addCall).toBeDefined();
    expect(addCall).toContain(shellEscape(path));
    expect(addCall).toContain(shellEscape('/tmp/ledger.md'));
  });

  test('no_commit_on_fail — a failing check → no commit, no git shell-out', async () => {
    // Remove the file path from DM-07 → tier1_paths fails.
    const spec = HAPPY_SPEC.replace(
      '| DM-07 | CHANGELOG | Docs | 1 | `CHANGELOG.md` | Wave 1 | required | |',
      '| DM-07 | CHANGELOG | Docs | 1 | | Wave 1 | required | |',
    );
    const path = await writeTempSpec(spec);

    const result = await handler.execute({ path, plan_id: 77 });
    const parsed = parseResult(result);

    expect(parsed.ready_for_approval).toBe(false);
    expect(parsed.committed).toBe(false);
    expect(parsed.commit_sha).toBe('');
    expect(parsed.refused_reason).toBeNull();
    // A failing check short-circuits before ANY git command.
    expect(flatCalls().some(c => c.includes('git'))).toBe(false);
  });

  test('refuses_on_protected — current branch is main → refused, checks still reported', async () => {
    setExecMock(gitResponder({ branch: 'main', staged: ['docs/x-devspec.md'] }));
    const path = await writeTempSpec(HAPPY_SPEC);

    const result = await handler.execute({ path, plan_id: 77 });
    const parsed = parseResult(result);

    expect(parsed.committed).toBe(false);
    expect(parsed.refused_reason).toBe('protected_branch');
    // Checks are still reported.
    expect(parsed.passed).toBe(8);
    expect(parsed.checks.length).toBe(8);
    // Refusal happens right after branch detection — no add/commit.
    expect(flatCalls().some(c => c.includes('git commit'))).toBe(false);
    expect(flatCalls().some(c => c.includes('git add'))).toBe(false);
  });

  test('refuses_on_protected — release/* is also protected', async () => {
    setExecMock(gitResponder({ branch: 'release/1.0.0', staged: ['docs/x-devspec.md'] }));
    const path = await writeTempSpec(HAPPY_SPEC);

    const result = await handler.execute({ path, plan_id: 77 });
    const parsed = parseResult(result);

    expect(parsed.committed).toBe(false);
    expect(parsed.refused_reason).toBe('protected_branch');
  });

  test('idempotent_no_changes — nothing staged → no commit, refused_reason no_changes', async () => {
    setExecMock(gitResponder({ branch: 'feature/458-x', staged: [] }));
    const path = await writeTempSpec(HAPPY_SPEC);

    const result = await handler.execute({ path, plan_id: 77 });
    const parsed = parseResult(result);

    expect(parsed.committed).toBe(false);
    expect(parsed.commit_sha).toBe('');
    expect(parsed.files).toEqual([]);
    expect(parsed.refused_reason).toBe('no_changes');
    // Staged nothing → never reach `git commit`.
    expect(flatCalls().some(c => c.includes('git commit'))).toBe(false);
  });

  test('backward_compat_shape — new fields coexist with ready_for_approval/passed/total/checks', async () => {
    const path = await writeTempSpec(HAPPY_SPEC);

    // No plan_id → pure validation, commits nothing (pre-#458 behavior).
    const result = await handler.execute({ path });
    const parsed = parseResult(result);

    // Legacy fields preserved.
    expect(parsed).toHaveProperty('ready_for_approval', true);
    expect(parsed).toHaveProperty('passed', 8);
    expect(parsed).toHaveProperty('total', 8);
    expect(Array.isArray(parsed.checks)).toBe(true);
    // New fields present and inert.
    expect(parsed).toHaveProperty('committed', false);
    expect(parsed).toHaveProperty('commit_sha', '');
    expect(parsed).toHaveProperty('files');
    expect(parsed.files).toEqual([]);
    expect(parsed).toHaveProperty('refused_reason', null);
    // Absent plan_id → no git shell-out at all.
    expect(flatCalls().some(c => c.includes('git'))).toBe(false);
  });

  test('no_push — the commit path never invokes git push', async () => {
    setExecMock(gitResponder({ branch: 'feature/458-x', staged: ['docs/x-devspec.md'], sha: 'cafe' }));
    const path = await writeTempSpec(HAPPY_SPEC);

    const result = await handler.execute({ path, plan_id: 77 });
    const parsed = parseResult(result);

    expect(parsed.committed).toBe(true);
    expect(flatCalls().some(c => c.includes('git push'))).toBe(false);
  });
});
