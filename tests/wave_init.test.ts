import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import {
  installChildProcessMock,
  setExecMock,
  resetExecMock,
  execCalls,
  mockExecSync,
} from '../lib/test-support/mock-child-process.ts';

// ---- Mocks ----------------------------------------------------------------
function lastExecCall(): string {
  const c = execCalls();
  return c[c.length - 1] ?? '';
}

const mockWriteFileSync = mock((_path: unknown, _data: unknown) => undefined);

installChildProcessMock();
// Story 2.22 (#316): the handler now imports `getAdapter()` which transitively
// pulls in `logger.ts` → `node:fs`. Bun aliases `'fs'` mocks to `'node:fs'`,
// so the mock surface must include every export `logger.ts` reaches for —
// otherwise `node:fs` resolves to a stub-less stand-in and the import fails
// with `Export named 'mkdirSync' not found`. Real fs calls are not expected
// during tests; these stubs are silently-noop defaults.
mock.module('fs', () => ({
  writeFileSync: mockWriteFileSync,
  appendFileSync: () => undefined,
  mkdirSync: () => undefined,
  existsSync: () => true,
}));

const { default: handler } = await import('../handlers/wave_init.ts');

const ORIGINAL_ENV = process.env.CLAUDE_PROJECT_DIR;

function resetMocks() {
  resetExecMock();
  setExecMock(() => 'wave plan initialized\n');
  mockWriteFileSync.mockClear();
}

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

async function setupStatusFixture(
  state: object | null,
  phasesWaves: object | null = null
): Promise<string> {
  const fixtureDir = `/tmp/wave-init-fixture-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  const statusDir = `${fixtureDir}/.claude/status`;
  if (state !== null) {
    await Bun.write(`${statusDir}/state.json`, JSON.stringify(state));
  }
  if (phasesWaves !== null) {
    await Bun.write(`${statusDir}/phases-waves.json`, JSON.stringify(phasesWaves));
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

describe('wave_init handler', () => {
  beforeEach(resetMocks);
  afterEach(() => {
    resetMocks();
    clearEnv();
  });

  test('handler exports valid HandlerDef shape', () => {
    expect(handler).toBeDefined();
    expect(handler.name).toBe('wave_init');
    expect(typeof handler.description).toBe('string');
    expect(handler.description.length).toBeGreaterThan(0);
    expect(handler.inputSchema).toBeDefined();
    expect(typeof handler.execute).toBe('function');
  });

  // ---- happy_path ---------------------------------------------------------
  test('happy_path — invokes wave-status init with plan file', async () => {
    // Fresh init (no --extend) does NOT read state.json, so no fixture required.
    // Point CLAUDE_PROJECT_DIR at a tempdir so the post-CLI phases-waves read
    // simply reports 0 totals.
    await setupStatusFixture(null);
    const planJson = JSON.stringify({ project: 'foo', phases: [] });
    const result = await handler.execute({ plan_json: planJson });
    expect(mockExecSync.mock.calls.length).toBe(1);
    expect(lastExecCall()).toContain('wave-status init');
    expect(lastExecCall()).not.toContain('--extend');
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.mode).toBe('init');
  });

  test('happy_path — passes --extend flag when extend=true', async () => {
    await setupStatusFixture({ waves: {} }, { phases: [] });
    const planJson = JSON.stringify({ phases: [{ name: 'extra', waves: [] }] });
    await handler.execute({ plan_json: planJson, extend: true });
    expect(lastExecCall()).toContain('wave-status init');
    expect(lastExecCall()).toContain('--extend');
  });

  test('happy_path — writes plan_json to a temp file', async () => {
    await setupStatusFixture(null);
    const planJson = JSON.stringify({ project: 'cc-workflow' });
    await handler.execute({ plan_json: planJson });
    expect(mockWriteFileSync.mock.calls.length).toBe(1);
    const writtenPath = mockWriteFileSync.mock.calls[0][0] as string;
    const writtenData = mockWriteFileSync.mock.calls[0][1] as string;
    expect(writtenPath).toMatch(/^\/tmp\/wave-init-plan-/);
    expect(writtenData).toBe(planJson);
  });

  // ---- cli_error ----------------------------------------------------------
  test('cli_error — returns ok:false on non-zero exit, does not throw', async () => {
    await setupStatusFixture(null);
    setExecMock(() => {
      throw new Error('wave-status: refusing to overwrite existing plan');
    });
    const result = await handler.execute({ plan_json: '{}' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('refusing to overwrite');
  });

  // ---- schema_validation --------------------------------------------------
  test('schema_validation — rejects missing plan_json', async () => {
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.length).toBeGreaterThan(0);
  });

  test('schema_validation — rejects empty plan_json string', async () => {
    const result = await handler.execute({ plan_json: '' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('plan_json');
  });

  test('schema_validation — rejects non-string plan_json', async () => {
    const result = await handler.execute({ plan_json: 123 });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });

  // ---- extend_collision ---------------------------------------------------
  test('extend_collision — returns ok:false with colliding_ids, does NOT invoke CLI', async () => {
    await setupStatusFixture(
      { waves: { 'W-1': { status: 'completed' } } },
      { phases: [{ waves: [{ id: 'W-1' }] }] }
    );
    const planJson = JSON.stringify({
      phases: [{ name: 'p1', waves: [{ id: 'W-1', issues: [{ number: 10 }] }] }],
    });
    const result = await handler.execute({ plan_json: planJson, extend: true });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(Array.isArray(parsed.colliding_ids)).toBe(true);
    expect(parsed.colliding_ids).toContain('W-1');
    expect(mockExecSync.mock.calls.length).toBe(0);
  });

  // ---- extend_no_collision ------------------------------------------------
  test('extend_no_collision — rich payload on success', async () => {
    await setupStatusFixture(
      { waves: { 'W-1': { status: 'completed' } } },
      {
        phases: [
          { waves: [{ id: 'W-1' }] },
          { waves: [{ id: 'W-2' }] },
        ],
      }
    );
    const planJson = JSON.stringify({
      phases: [
        {
          name: 'p2',
          waves: [
            {
              id: 'W-2',
              issues: [
                { number: 20 },
                { number: 21 },
              ],
            },
          ],
        },
      ],
    });
    const result = await handler.execute({ plan_json: planJson, extend: true });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.mode).toBe('extend');
    expect(parsed.waves_added).toBeGreaterThanOrEqual(1);
    expect(parsed.phases_added).toBeGreaterThanOrEqual(1);
    expect(parsed.issues_added).toBe(2);
    expect(typeof parsed.total_phases).toBe('number');
    expect(typeof parsed.total_waves).toBe('number');
    expect(mockExecSync.mock.calls.length).toBe(1);
  });

  // ---- fresh_init_rich_payload --------------------------------------------
  test('fresh_init_rich_payload — non-extend path returns numeric totals', async () => {
    await setupStatusFixture(null, {
      phases: [
        { waves: [{ id: 'W-1' }, { id: 'W-2' }] },
      ],
    });
    const planJson = JSON.stringify({
      phases: [
        {
          name: 'p1',
          waves: [
            { id: 'W-1', issues: [{ number: 1 }] },
            { id: 'W-2', issues: [{ number: 2 }, { number: 3 }] },
          ],
        },
      ],
    });
    const result = await handler.execute({ plan_json: planJson, extend: false });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.mode).toBe('init');
    expect(typeof parsed.phases_added).toBe('number');
    expect(parsed.phases_added).toBe(1);
    expect(parsed.waves_added).toBe(2);
    expect(parsed.issues_added).toBe(3);
    expect(typeof parsed.total_waves).toBe('number');
  });

  // ---- project_root_param -------------------------------------------------
  test('project_root_param — overrides CLAUDE_PROJECT_DIR', async () => {
    // Env points somewhere else, but project_root should win and become the
    // execSync cwd.
    const envDir = `/tmp/wave-init-env-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const overrideDir = `/tmp/wave-init-override-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    process.env.CLAUDE_PROJECT_DIR = envDir;
    const planJson = JSON.stringify({ project: 'foo', phases: [] });
    await handler.execute({ plan_json: planJson, project_root: overrideDir });
    expect(mockExecSync.mock.calls.length).toBe(1);
    const opts = mockExecSync.mock.calls[0][1] as { cwd?: string } | undefined;
    expect(opts?.cwd).toBe(overrideDir);
  });

  // ---- repo_param ---------------------------------------------------------
  test('repo_param — appends --repo flag to CLI call', async () => {
    await setupStatusFixture(null);
    const planJson = JSON.stringify({ project: 'foo', phases: [] });
    await handler.execute({ plan_json: planJson, repo: 'Wave-Engineering/sdlc' });
    expect(lastExecCall()).toContain('wave-status init');
    // Value is single-quoted for shell safety; consistent with wave_record_mr.
    expect(lastExecCall()).toContain(`--repo 'Wave-Engineering/sdlc'`);
  });

  test('repo_param — rejects invalid repo format', async () => {
    const result = await handler.execute({
      plan_json: JSON.stringify({ phases: [] }),
      repo: 'not-a-valid-repo',
    });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('owner/repo');
  });

  // ---- kahuna bootstrap (devspec §5.1.3) ----------------------------------

  /**
   * Helper: install an execMockFn that routes commands by substring match.
   * Tests register a map of {substring → response or thrower}; unmatched
   * commands fall through to the default `wave plan initialized` response so
   * the existing wave-status init call keeps working.
   *
   * Story 2.22 (#316): matches against both the raw cmd AND a single-quote
   * stripped version so route expressions written for the legacy non-escaped
   * handler form also match the adapter's `runArgv`-produced per-token quoted
   * form (`'git' 'ls-remote' ...`). The handler-owned execSync calls
   * (`wave-status ...`, `parseRepoSlug`'s `git remote get-url`) still use the
   * legacy format; adapter calls now go through `runArgv`.
   */
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
      // #472: when the plan omits base_branch, the kahuna path now resolves the
      // LIVE default branch (previously hardcoded 'main'). Answer both platforms'
      // default-branch lookup with 'main' — unless a test overrides it via an
      // explicit route above — so the existing `heads/main` SHA routes still hit.
      if (flat.includes('defaultBranchRef')) return 'main';                          // github: gh repo view
      if (/glab api projects\/[^/]+$/.test(flat)) return JSON.stringify({ default_branch: 'main' }); // gitlab: bare projects/<id>
      return 'wave plan initialized\n';
    });
  }

  test('kahuna bootstrap — fresh creation: branch absent everywhere → creates and records', async () => {
    await setupStatusFixture({ kahuna_branch: null });
    setExecRoutes([
      { match: 'git remote get-url', respond: 'git@github.com:Wave-Engineering/mcp-server-sdlc.git' },
      { match: 'git ls-remote --heads origin', respond: '' }, // branch absent
      // Story 2.22 (#316): adapter uses `gh api repos/<slug>/git/refs/heads/<branch> --jq .object.sha`.
      { match: 'gh api repos/Wave-Engineering/mcp-server-sdlc/git/refs/heads/main', respond: '0000000000000000000000000000000000000abc' },
      { match: 'gh api repos/Wave-Engineering/mcp-server-sdlc/git/refs -X POST', respond: '' },
      { match: 'wave-status set-kahuna-branch', respond: '' },
    ]);

    const result = await handler.execute({
      plan_json: JSON.stringify({ phases: [] }),
      kahuna: { plan_id: 42, slug: 'wave-status-cli' },
    });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.kahuna_branch).toBe('kahuna/42-wave-status-cli');
    expect(parsed.kahuna_created).toBe(true);

    // The platform API was actually called to create the branch. Adapter
    // argv is per-token shell-escaped (`'gh' 'api' 'repos/…' …`), so match
    // against an unquoted view of each recorded call.
    const calls = mockExecSync.mock.calls.map(c => unquote(c[0] as string));
    expect(calls.some(c => c.includes('gh api repos/Wave-Engineering/mcp-server-sdlc/git/refs -X POST'))).toBe(true);
    expect(calls.some(c => c.includes('ref=refs/heads/kahuna/42-wave-status-cli'))).toBe(true);
    expect(calls.some(c => c.includes('sha=0000000000000000000000000000000000000abc'))).toBe(true);
    // And state was updated via the new CLI subcommand (handler's own
    // execSync, still in legacy quoted form).
    const rawCalls = mockExecSync.mock.calls.map(c => c[0] as string);
    expect(rawCalls.some(c => c.includes("wave-status set-kahuna-branch 'kahuna/42-wave-status-cli'"))).toBe(true);
  });

  test('kahuna bootstrap — idempotent reuse: state matches and branch exists on remote → no creation', async () => {
    await setupStatusFixture({ kahuna_branch: 'kahuna/42-wave-status-cli' });
    setExecRoutes([
      { match: 'git remote get-url', respond: 'git@github.com:Wave-Engineering/mcp-server-sdlc.git' },
      { match: 'git ls-remote --heads origin', respond: 'abc123\trefs/heads/kahuna/42-wave-status-cli' },
    ]);

    const result = await handler.execute({
      plan_json: JSON.stringify({ phases: [] }),
      kahuna: { plan_id: 42, slug: 'wave-status-cli' },
    });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.kahuna_branch).toBe('kahuna/42-wave-status-cli');
    expect(parsed.kahuna_created).toBe(false);

    // No branch creation, no state-write CLI call
    const calls = mockExecSync.mock.calls.map(c => c[0] as string);
    expect(calls.some(c => c.includes('git/refs -X POST'))).toBe(false);
    expect(calls.some(c => c.includes('set-kahuna-branch'))).toBe(false);
  });

  test('kahuna bootstrap — orphan-with-matching-name claimed (#378): retry-after-failed-init converges', async () => {
    // #378 behavior change: when state has no kahuna_branch but the remote
    // already has the EXACT desired branch (`kahuna/<plan_id>-<slug>`),
    // claim it as idempotent reuse rather than refusing as an orphan. This
    // makes wave_init retry-safe after a `wave-status init` failure that
    // left the kahuna branch on remote but never persisted state.json's
    // kahuna_branch field.
    await setupStatusFixture({ kahuna_branch: null });
    setExecRoutes([
      { match: 'git remote get-url', respond: 'git@github.com:Wave-Engineering/mcp-server-sdlc.git' },
      { match: 'git ls-remote --heads origin', respond: 'abc123\trefs/heads/kahuna/42-foo' },
      { match: 'wave-status set-kahuna-branch', respond: '' },
    ]);

    const result = await handler.execute({
      plan_json: JSON.stringify({ phases: [] }),
      kahuna: { plan_id: 42, slug: 'foo' },
    });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.kahuna_branch).toBe('kahuna/42-foo');
    expect(parsed.kahuna_created).toBe(false);

    // No new branch creation API call (we claimed the existing one)
    const calls = mockExecSync.mock.calls.map(c => unquote(c[0] as string));
    expect(calls.some(c => c.includes('git/refs -X POST'))).toBe(false);
    // But the branch IS recorded in state because state had it as null
    const rawCalls = mockExecSync.mock.calls.map(c => c[0] as string);
    expect(rawCalls.some(c => c.includes("wave-status set-kahuna-branch 'kahuna/42-foo'"))).toBe(true);
  });

  test('kahuna bootstrap — state-mismatch refused: state has different branch', async () => {
    await setupStatusFixture({ kahuna_branch: 'kahuna/41-prior-epic' });
    setExecRoutes([
      { match: 'git remote get-url', respond: 'git@github.com:Wave-Engineering/mcp-server-sdlc.git' },
    ]);

    const result = await handler.execute({
      plan_json: JSON.stringify({ phases: [] }),
      kahuna: { plan_id: 42, slug: 'new-epic' },
    });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(false);
    expect(parsed.error as string).toContain('kahuna/41-prior-epic');
    expect(parsed.error as string).toContain('kahuna/42-new-epic');
  });

  test('kahuna bootstrap — recorded but missing on remote: refuse (state/platform desync)', async () => {
    await setupStatusFixture({ kahuna_branch: 'kahuna/42-foo' });
    setExecRoutes([
      { match: 'git remote get-url', respond: 'git@github.com:Wave-Engineering/mcp-server-sdlc.git' },
      { match: 'git ls-remote --heads origin', respond: '' }, // branch missing
    ]);

    const result = await handler.execute({
      plan_json: JSON.stringify({ phases: [] }),
      kahuna: { plan_id: 42, slug: 'foo' },
    });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(false);
    expect(parsed.error as string).toContain('missing from remote');
    expect(parsed.error as string).toContain('triage');
  });

  test('kahuna bootstrap — schema rejects uppercase or non-kebab slug', async () => {
    const result = await handler.execute({
      plan_json: JSON.stringify({ phases: [] }),
      kahuna: { plan_id: 42, slug: 'BadSlug' },
    });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error as string).toContain('kebab-case');
  });

  test('kahuna bootstrap — schema rejects non-positive plan_id', async () => {
    const result = await handler.execute({
      plan_json: JSON.stringify({ phases: [] }),
      kahuna: { plan_id: 0, slug: 'foo' },
    });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });

  test('kahuna bootstrap — backward compat: omitting kahuna leaves response field absent', async () => {
    await setupStatusFixture(null);
    const result = await handler.execute({
      plan_json: JSON.stringify({ phases: [] }),
    });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.kahuna_branch).toBeUndefined();
    expect(parsed.kahuna_created).toBeUndefined();
  });

  test('kahuna bootstrap — gitlab platform: uses glab api for branch creation', async () => {
    await setupStatusFixture({ kahuna_branch: null });
    setExecRoutes([
      { match: 'git remote get-url', respond: 'git@gitlab.com:my-group/my-repo.git' },
      { match: 'git ls-remote --heads origin', respond: '' },
      // Story 2.22 (#316): adapter's GitLab resolveBranchSha uses
      // `glab api projects/<encoded>/repository/branches/<branch>` with no
      // trailing `--jq` (parses JSON client-side).
      { match: 'glab api projects/my-group%2Fmy-repo/repository/branches/main', respond: JSON.stringify({ commit: { id: '3333333333333333333333333333333333333333' } }) },
      { match: 'glab api projects/my-group%2Fmy-repo/repository/branches -X POST', respond: '' },
      { match: 'wave-status set-kahuna-branch', respond: '' },
    ]);

    const result = await handler.execute({
      plan_json: JSON.stringify({ phases: [] }),
      kahuna: { plan_id: 7, slug: 'feature-x' },
    });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.kahuna_branch).toBe('kahuna/7-feature-x');
    const calls = mockExecSync.mock.calls.map(c => unquote(c[0] as string));
    expect(calls.some(c => c.includes('glab api projects/my-group%2Fmy-repo/repository/branches -X POST'))).toBe(true);
    expect(calls.some(c => c.includes('branch=kahuna/7-feature-x'))).toBe(true);
    expect(calls.some(c => c.includes('ref=3333333333333333333333333333333333333333'))).toBe(true);
  });

  test('kahuna bootstrap — uses plan.base_branch when provided (default main)', async () => {
    await setupStatusFixture({ kahuna_branch: null });
    setExecRoutes([
      { match: 'git remote get-url', respond: 'git@github.com:org/repo.git' },
      { match: 'git ls-remote --heads origin', respond: '' },
      // Adapter URL: `/git/refs/heads/<branch> --jq .object.sha`.
      { match: 'gh api repos/org/repo/git/refs/heads/develop', respond: '1111111111111111111111111111111111111111' },
      { match: 'gh api repos/org/repo/git/refs -X POST', respond: '' },
      { match: 'wave-status set-kahuna-branch', respond: '' },
    ]);

    const result = await handler.execute({
      plan_json: JSON.stringify({ phases: [], base_branch: 'develop' }),
      kahuna: { plan_id: 99, slug: 'foo' },
    });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    const calls = mockExecSync.mock.calls.map(c => unquote(c[0] as string));
    expect(calls.some(c => c.includes('git/refs/heads/develop'))).toBe(true);
    expect(calls.some(c => c.includes('sha=1111111111111111111111111111111111111111'))).toBe(true);
  });

  test('kahuna bootstrap — gh api returns non-SHA garbage: defensive validator rejects', async () => {
    await setupStatusFixture({ kahuna_branch: null });
    setExecRoutes([
      { match: 'git remote get-url', respond: 'git@github.com:org/repo.git' },
      { match: 'git ls-remote --heads origin', respond: '' },
      // Could happen if the API shape changes or --jq returns null/empty.
      // Adapter's SHA-validator soft-fails to null → handler surfaces as
      // "failed to read main HEAD SHA". Either way the creation path stays
      // un-entered — same defense as the pre-migration validator.
      { match: 'gh api repos/org/repo/git/refs/heads/main', respond: 'null' },
    ]);

    const result = await handler.execute({
      plan_json: JSON.stringify({ phases: [] }),
      kahuna: { plan_id: 1, slug: 'foo' },
    });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error as string).toContain('failed to read main HEAD SHA');
    // Critically, no branch creation attempted with the bogus SHA
    const calls = mockExecSync.mock.calls.map(c => unquote(c[0] as string));
    expect(calls.some(c => c.includes('git/refs -X POST'))).toBe(false);
  });

  test('kahuna bootstrap — gh api command does NOT use --repo flag (gh api is path-resolved)', async () => {
    await setupStatusFixture({ kahuna_branch: null });
    setExecRoutes([
      { match: 'git remote get-url', respond: 'git@github.com:org/repo.git' },
      { match: 'git ls-remote --heads origin', respond: '' },
      { match: 'gh api repos/org/repo/git/refs/heads/main', respond: '4444444444444444444444444444444444444444' },
      { match: 'gh api repos/org/repo/git/refs -X POST', respond: '' },
      { match: 'wave-status set-kahuna-branch', respond: '' },
    ]);

    await handler.execute({
      plan_json: JSON.stringify({ phases: [] }),
      kahuna: { plan_id: 1, slug: 'foo' },
    });

    // Regression: --repo is a porcelain flag, not valid on `gh api`.
    const calls = mockExecSync.mock.calls.map(c => c[0] as string);
    const ghApiCalls = calls.filter(c => c.includes('gh api'));
    for (const c of ghApiCalls) {
      expect(c).not.toContain('--repo');
    }
  });

  test('kahuna bootstrap — base_branch with shell metacharacters is rejected by adapter validator', async () => {
    // Story 2.22 (#316): pre-migration shell-escaped malicious branch names
    // into the URL path. The adapter's validator is STRONGER — it rejects
    // branches outside `[A-Za-z0-9._\\-/]+` up front, so no subprocess is
    // invoked with the malicious value at all.
    await setupStatusFixture({ kahuna_branch: null });
    setExecRoutes([
      { match: 'git remote get-url', respond: 'git@github.com:org/repo.git' },
      { match: 'git ls-remote --heads origin', respond: '' },
    ]);

    const result = await handler.execute({
      plan_json: JSON.stringify({ phases: [], base_branch: 'weird; rm -rf /' }),
      kahuna: { plan_id: 1, slug: 'foo' },
    });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    // No gh/glab api call made with the malicious branch — validator fires first.
    const calls = mockExecSync.mock.calls.map(c => c[0] as string);
    expect(calls.some(c => c.includes('rm -rf'))).toBe(false);
  });

  test('kahuna bootstrap — wave-status set-kahuna-branch failure surfaces as ok:false', async () => {
    await setupStatusFixture({ kahuna_branch: null });
    setExecRoutes([
      { match: 'git remote get-url', respond: 'git@github.com:org/repo.git' },
      { match: 'git ls-remote --heads origin', respond: '' },
      { match: 'gh api repos/org/repo/git/refs/heads/main', respond: '2222222222222222222222222222222222222222' },
      { match: 'gh api repos/org/repo/git/refs -X POST', respond: '' },
      { match: 'wave-status set-kahuna-branch', respond: () => { throw new Error('CLI exploded'); } },
    ]);

    const result = await handler.execute({
      plan_json: JSON.stringify({ phases: [] }),
      kahuna: { plan_id: 1, slug: 'foo' },
    });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(false);
    expect(parsed.error as string).toContain('set-kahuna-branch');
  });

  // ---- atomicity (#378) — kahuna bootstrap before plan persist ------------
  //
  // The handler resequenced its steps so the kahuna branch is created on the
  // remote BEFORE `wave-status init` persists the plan to disk. This block
  // pins the ordering and the failure semantics that make wave_init atomic.

  test('atomicity (#378) — ordering: kahuna branch create runs BEFORE wave-status init', async () => {
    await setupStatusFixture({ kahuna_branch: null });
    setExecRoutes([
      { match: 'git remote get-url', respond: 'git@github.com:org/repo.git' },
      { match: 'git ls-remote --heads origin', respond: '' },
      { match: 'gh api repos/org/repo/git/refs/heads/main', respond: '5555555555555555555555555555555555555555' },
      { match: 'gh api repos/org/repo/git/refs -X POST', respond: '' },
      { match: 'wave-status set-kahuna-branch', respond: '' },
    ]);

    const result = await handler.execute({
      plan_json: JSON.stringify({ phases: [] }),
      kahuna: { plan_id: 7, slug: 'order-test' },
    });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);

    const calls = mockExecSync.mock.calls.map(c => unquote(c[0] as string));
    const createBranchIdx = calls.findIndex(c => c.includes('gh api repos/org/repo/git/refs -X POST'));
    const initIdx = calls.findIndex(c => c.includes('wave-status init'));
    const setKahunaIdx = calls.findIndex(c => c.includes('wave-status set-kahuna-branch'));
    expect(createBranchIdx).toBeGreaterThanOrEqual(0);
    expect(initIdx).toBeGreaterThan(createBranchIdx);
    expect(setKahunaIdx).toBeGreaterThan(initIdx);
  });

  test('atomicity (#378) — kahuna failure: branch creation fails → wave-status init NEVER runs', async () => {
    // Inject a failure in the branch-create platform call. The handler must
    // bail before `wave-status init` is invoked so the plan is not persisted
    // and the half-state ("plan on disk + kahuna missing") is impossible.
    await setupStatusFixture({ kahuna_branch: null });
    setExecRoutes([
      { match: 'git remote get-url', respond: 'git@github.com:org/repo.git' },
      { match: 'git ls-remote --heads origin', respond: '' },
      { match: 'gh api repos/org/repo/git/refs/heads/main', respond: '6666666666666666666666666666666666666666' },
      { match: 'gh api repos/org/repo/git/refs -X POST', respond: () => { throw new Error('GraphQL: branch creation refused'); } },
    ]);

    const result = await handler.execute({
      plan_json: JSON.stringify({ phases: [], project: 'foo' }),
      kahuna: { plan_id: 8, slug: 'fail-create' },
    });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);

    // Critical: `wave-status init` was NEVER called — plan not persisted.
    const calls = mockExecSync.mock.calls.map(c => c[0] as string);
    expect(calls.some(c => c.includes('wave-status init'))).toBe(false);
    expect(calls.some(c => c.includes('wave-status set-kahuna-branch'))).toBe(false);
  });

  test('atomicity (#378) — kahuna failure: SHA resolve fails → wave-status init NEVER runs', async () => {
    // Same guarantee, different injection point: base_branch SHA lookup fails
    // (e.g. branch doesn't exist or auth error). Plan must not be persisted.
    await setupStatusFixture({ kahuna_branch: null });
    setExecRoutes([
      { match: 'git remote get-url', respond: 'git@github.com:org/repo.git' },
      { match: 'git ls-remote --heads origin', respond: '' },
      { match: 'gh api repos/org/repo/git/refs/heads/main', respond: () => { throw new Error('HTTP 404: Not Found'); } },
    ]);

    const result = await handler.execute({
      plan_json: JSON.stringify({ phases: [] }),
      kahuna: { plan_id: 9, slug: 'fail-sha' },
    });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error as string).toContain('failed to read main HEAD SHA');

    const calls = mockExecSync.mock.calls.map(c => c[0] as string);
    expect(calls.some(c => c.includes('wave-status init'))).toBe(false);
    expect(calls.some(c => c.includes('git/refs -X POST'))).toBe(false);
  });

  test('atomicity (#378) — state-mismatch refusal: extend mode with stale recorded branch → init NEVER runs', async () => {
    // Pre-existing kahuna_branch in state.json that doesn't match the new
    // request's plan_id+slug. This is the "stale kahuna from prior epic" case
    // from issue #378's session 1 repro. wave-status init must NOT run.
    await setupStatusFixture({ waves: {}, kahuna_branch: 'kahuna/41-prior-epic' }, { phases: [] });
    setExecRoutes([
      { match: 'git remote get-url', respond: 'git@github.com:org/repo.git' },
    ]);

    const result = await handler.execute({
      plan_json: JSON.stringify({ phases: [{ name: 'p', waves: [{ id: 'W-99', issues: [] }] }] }),
      extend: true,
      kahuna: { plan_id: 42, slug: 'new-epic' },
    });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);

    // wave-status init must not have run — the prescan is the only state-
    // touching CLI invocation that's allowed before the kahuna pre-check, and
    // the prescan is read-only.
    const calls = mockExecSync.mock.calls.map(c => c[0] as string);
    expect(calls.some(c => c.includes('wave-status init'))).toBe(false);
    expect(calls.some(c => c.includes('wave-status set-kahuna-branch'))).toBe(false);
  });

  test('atomicity (#378) — retry semantics: orphan branch on remote + empty state → idempotent claim, init runs', async () => {
    // Models the post-failure retry: prior wave_init's `wave-status init` step
    // failed AFTER the kahuna branch was created on remote, so the remote has
    // the branch but state.json's kahuna_branch is empty. On retry, the new
    // call must claim the orphan as idempotent reuse and then proceed to
    // re-attempt the plan persist.
    await setupStatusFixture({ kahuna_branch: null });
    setExecRoutes([
      { match: 'git remote get-url', respond: 'git@github.com:org/repo.git' },
      { match: 'git ls-remote --heads origin', respond: 'abc123\trefs/heads/kahuna/10-retry' },
      { match: 'wave-status set-kahuna-branch', respond: '' },
    ]);

    const result = await handler.execute({
      plan_json: JSON.stringify({ phases: [] }),
      kahuna: { plan_id: 10, slug: 'retry' },
    });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.kahuna_branch).toBe('kahuna/10-retry');
    expect(parsed.kahuna_created).toBe(false);

    // Plan persist DID run (retry converged), and the orphan was recorded.
    const rawCalls = mockExecSync.mock.calls.map(c => c[0] as string);
    expect(rawCalls.some(c => c.includes('wave-status init'))).toBe(true);
    expect(rawCalls.some(c => c.includes("wave-status set-kahuna-branch 'kahuna/10-retry'"))).toBe(true);
    // No NEW branch creation — claimed the existing one
    expect(rawCalls.some(c => c.includes('git/refs -X POST'))).toBe(false);
  });

  test('atomicity (#378) — extend retry after kahuna fail: no wave-ID collision because plan never persisted', async () => {
    // The original repro: extend-mode wave_init fails on kahuna step. The
    // wave IDs in the new plan must NOT have been added to state.json — so a
    // retry with the same plan does not trip the wave-ID-collision prescan.
    await setupStatusFixture(
      { waves: { 'W-1': { status: 'completed' } }, kahuna_branch: null },
      { phases: [] }
    );
    setExecRoutes([
      { match: 'git remote get-url', respond: 'git@github.com:org/repo.git' },
      { match: 'git ls-remote --heads origin', respond: '' },
      // First call: SHA resolve fails (simulates network blip)
      { match: 'gh api repos/org/repo/git/refs/heads/main', respond: () => { throw new Error('HTTP 503'); } },
    ]);

    const planJson = JSON.stringify({
      phases: [{ name: 'p2', waves: [{ id: 'W-2', issues: [{ number: 20 }] }] }],
    });
    const firstResult = await handler.execute({
      plan_json: planJson,
      extend: true,
      kahuna: { plan_id: 11, slug: 'collision-test' },
    });
    const firstParsed = parseResult(firstResult);
    expect(firstParsed.ok).toBe(false);

    // First call did NOT call `wave-status init`, so the W-2 wave ID is NOT
    // in state.json. The second call's extend-mode prescan must not flag
    // W-2 as colliding.
    const firstCalls = mockExecSync.mock.calls.map(c => c[0] as string);
    expect(firstCalls.some(c => c.includes('wave-status init'))).toBe(false);

    // Second call: same input, this time the SHA resolves and create succeeds.
    mockExecSync.mockClear();
    setExecRoutes([
      { match: 'git remote get-url', respond: 'git@github.com:org/repo.git' },
      { match: 'git ls-remote --heads origin', respond: '' },
      { match: 'gh api repos/org/repo/git/refs/heads/main', respond: '7777777777777777777777777777777777777777' },
      { match: 'gh api repos/org/repo/git/refs -X POST', respond: '' },
      { match: 'wave-status set-kahuna-branch', respond: '' },
    ]);

    const secondResult = await handler.execute({
      plan_json: planJson,
      extend: true,
      kahuna: { plan_id: 11, slug: 'collision-test' },
    });
    const secondParsed = parseResult(secondResult);
    expect(secondParsed.ok).toBe(true);
    expect(secondParsed.kahuna_branch).toBe('kahuna/11-collision-test');
    expect(secondParsed.kahuna_created).toBe(true);

    // Critically, the prescan did NOT flag a collision — W-2 was never on disk.
    expect(secondParsed.colliding_ids).toBeUndefined();
  });

  test('atomicity (#378) — fresh init: no kahuna arg → only ONE execSync (back-compat)', async () => {
    // When `kahuna` is omitted, the handler does NOT call parseRepoSlug or
    // any platform API — only the `wave-status init` call. This pins the
    // back-compat happy path (no kahuna, no slug detection overhead).
    await setupStatusFixture(null);
    const planJson = JSON.stringify({ project: 'foo', phases: [] });
    const result = await handler.execute({ plan_json: planJson });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(mockExecSync.mock.calls.length).toBe(1);
    expect((mockExecSync.mock.calls[0][0] as string)).toContain('wave-status init');
  });

  // ---- extend_missing_state -----------------------------------------------
  test('extend_missing_state — returns ok:false without throwing', async () => {
    // Point at a fresh empty tempdir; no state.json exists.
    const fixtureDir = `/tmp/wave-init-empty-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    process.env.CLAUDE_PROJECT_DIR = fixtureDir;
    const planJson = JSON.stringify({
      phases: [{ name: 'p1', waves: [{ id: 'W-9', issues: [] }] }],
    });
    const result = await handler.execute({ plan_json: planJson, extend: true });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(typeof parsed.error).toBe('string');
    expect(mockExecSync.mock.calls.length).toBe(0);
  });

  test('force_param — passes --force flag to wave-status init', async () => {
    await setupStatusFixture(null);
    const planJson = JSON.stringify({ project: 'org/repo', phases: [] });
    const result = await handler.execute({ plan_json: planJson, force: true });
    expect(lastExecCall()).toContain('wave-status init');
    expect(lastExecCall()).toContain('--force');
    expect(lastExecCall()).not.toContain('--extend');
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
  });

  test('force_param — not present when force is false/omitted', async () => {
    await setupStatusFixture(null);
    const planJson = JSON.stringify({ project: 'org/repo', phases: [] });
    const result = await handler.execute({ plan_json: planJson });
    expect(lastExecCall()).not.toContain('--force');
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
  });
});
