// Story 2.1 (#362) — positive case: `wave_init` with the new
// `kahuna: { plan_id, slug }` shape creates a `kahuna/<plan_id>-<slug>` branch
// and records it in wave state.
//
// This file is a thin, focused companion to `tests/wave_init.test.ts`. The
// main suite covers the full bootstrap matrix (GitHub vs GitLab, idempotent
// reuse, orphan/desync, etc.); here we just pin the AC-1 + AC-2 contract.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { installChildProcessMock, setExecMock, resetExecMock, mockExecSync } from '../lib/test-support/mock-child-process.ts';
// Shared `fs` mock (#456) — see mock-fs.ts header; the handler's transitive
// `logger.ts` → `node:fs` pull requires the full logger trio in the surface.
import { installFsMock, resetFsMock } from '../lib/test-support/mock-fs.ts';

installChildProcessMock();
installFsMock();

const { default: handler } = await import('../handlers/wave_init.ts');

const ORIGINAL_ENV = process.env.CLAUDE_PROJECT_DIR;

function resetMocks() {
  resetExecMock();
  setExecMock(() => 'wave plan initialized\n');
  resetFsMock();
}

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

async function setupStatusFixture(state: object | null): Promise<string> {
  const fixtureDir = `/tmp/wave-init-plan-id-fixture-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  const statusDir = `${fixtureDir}/.claude/status`;
  if (state !== null) {
    await Bun.write(`${statusDir}/state.json`, JSON.stringify(state));
  }
  process.env.CLAUDE_PROJECT_DIR = fixtureDir;
  return fixtureDir;
}

function clearEnv() {
  if (ORIGINAL_ENV === undefined) {
    delete process.env.CLAUDE_PROJECT_DIR;
  } else {
    process.env.CLAUDE_PROJECT_DIR = ORIGINAL_ENV;
  }
}

function unquote(cmd: string): string {
  return cmd.replace(/'([^']*)'/g, '$1');
}

function setExecRoutes(routes: Array<{ match: string; respond: string | (() => string) }>): void {
  setExecMock((cmd: string) => {
    const flat = unquote(cmd);
    for (const r of routes) {
      if (cmd.includes(r.match) || flat.includes(r.match)) {
        return typeof r.respond === 'function' ? r.respond() : r.respond;
      }
    }
    // #472: kahuna path resolves the live default branch when base_branch is
    // omitted — answer the default-branch lookup with 'main' so the existing
    // `heads/main` SHA route still hits.
    if (flat.includes('defaultBranchRef')) return 'main';
    return 'wave plan initialized\n';
  });
}

describe('wave_init — kahuna: { plan_id, slug } (Story 2.1 / #362)', () => {
  beforeEach(resetMocks);
  afterEach(() => {
    resetMocks();
    clearEnv();
  });

  test('plan_id + slug → creates kahuna/<plan_id>-<slug> branch and records it', async () => {
    await setupStatusFixture({ kahuna_branch: null });
    setExecRoutes([
      { match: 'git remote get-url', respond: 'git@github.com:Wave-Engineering/mcp-server-sdlc.git' },
      { match: 'git ls-remote --heads origin', respond: '' },
      { match: 'gh api repos/Wave-Engineering/mcp-server-sdlc/git/refs/heads/main', respond: '0000000000000000000000000000000000000abc' },
      { match: 'gh api repos/Wave-Engineering/mcp-server-sdlc/git/refs -X POST', respond: '' },
      { match: 'wave-status set-kahuna-branch', respond: '' },
    ]);

    const result = await handler.execute({
      plan_json: JSON.stringify({ phases: [] }),
      kahuna: { plan_id: 42, slug: 'cross-repo-rename' },
    });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.kahuna_branch).toBe('kahuna/42-cross-repo-rename');
    expect(parsed.kahuna_created).toBe(true);

    // State was written via the wave-status CLI with the new branch name
    const rawCalls = mockExecSync.mock.calls.map(c => c[0] as string);
    expect(rawCalls.some(c => c.includes("wave-status set-kahuna-branch 'kahuna/42-cross-repo-rename'"))).toBe(true);
  });
});
