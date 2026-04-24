import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';

// ---- Mocks ----------------------------------------------------------------
let lastExecCall = '';
let execMockFn: (cmd: string) => string = () => 'wave plan initialized\n';

const mockExecSync = mock((cmd: string, _opts?: unknown) => {
  lastExecCall = cmd;
  return execMockFn(cmd);
});

const mockWriteFileSync = mock((_path: unknown, _data: unknown) => undefined);

mock.module('child_process', () => ({ execSync: mockExecSync }));
mock.module('fs', () => ({ writeFileSync: mockWriteFileSync }));

const { default: handler } = await import('../handlers/wave_init.ts');

const ORIGINAL_ENV = process.env.CLAUDE_PROJECT_DIR;

function resetMocks() {
  lastExecCall = '';
  execMockFn = () => 'wave plan initialized\n';
  mockExecSync.mockClear();
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
    expect(lastExecCall).toContain('wave-status init');
    expect(lastExecCall).not.toContain('--extend');
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.mode).toBe('init');
  });

  test('happy_path — passes --extend flag when extend=true', async () => {
    await setupStatusFixture({ waves: {} }, { phases: [] });
    const planJson = JSON.stringify({ phases: [{ name: 'extra', waves: [] }] });
    await handler.execute({ plan_json: planJson, extend: true });
    expect(lastExecCall).toContain('wave-status init');
    expect(lastExecCall).toContain('--extend');
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
    execMockFn = () => {
      throw new Error('wave-status: refusing to overwrite existing plan');
    };
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
    expect(lastExecCall).toContain('wave-status init');
    // Value is single-quoted for shell safety; consistent with wave_record_mr.
    expect(lastExecCall).toContain(`--repo 'Wave-Engineering/sdlc'`);
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
   */
  function setExecRoutes(routes: Array<{ match: string; respond: string | (() => string) }>): void {
    execMockFn = (cmd: string) => {
      for (const r of routes) {
        if (cmd.includes(r.match)) {
          return typeof r.respond === 'function' ? r.respond() : r.respond;
        }
      }
      return 'wave plan initialized\n';
    };
  }

  test('kahuna bootstrap — fresh creation: branch absent everywhere → creates and records', async () => {
    await setupStatusFixture({ kahuna_branch: null });
    setExecRoutes([
      { match: 'git remote get-url', respond: 'git@github.com:Wave-Engineering/mcp-server-sdlc.git' },
      { match: 'git ls-remote --heads origin', respond: '' }, // branch absent
      { match: "gh api repos/Wave-Engineering/mcp-server-sdlc/branches/'main'", respond: '0000000000000000000000000000000000000abc' },
      { match: 'gh api repos/Wave-Engineering/mcp-server-sdlc/git/refs', respond: '' },
      { match: 'wave-status set-kahuna-branch', respond: '' },
    ]);

    const result = await handler.execute({
      plan_json: JSON.stringify({ phases: [] }),
      kahuna: { epic_id: 42, slug: 'wave-status-cli' },
    });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.kahuna_branch).toBe('kahuna/42-wave-status-cli');
    expect(parsed.kahuna_created).toBe(true);

    // The platform API was actually called to create the branch
    const calls = mockExecSync.mock.calls.map(c => c[0] as string);
    expect(calls.some(c => c.includes('gh api repos/Wave-Engineering/mcp-server-sdlc/git/refs -X POST'))).toBe(true);
    expect(calls.some(c => c.includes("ref='refs/heads/kahuna/42-wave-status-cli'"))).toBe(true);
    expect(calls.some(c => c.includes("sha='0000000000000000000000000000000000000abc'"))).toBe(true);
    // And state was updated via the new CLI subcommand
    expect(calls.some(c => c.includes("wave-status set-kahuna-branch 'kahuna/42-wave-status-cli'"))).toBe(true);
  });

  test('kahuna bootstrap — idempotent reuse: state matches and branch exists on remote → no creation', async () => {
    await setupStatusFixture({ kahuna_branch: 'kahuna/42-wave-status-cli' });
    setExecRoutes([
      { match: 'git remote get-url', respond: 'git@github.com:Wave-Engineering/mcp-server-sdlc.git' },
      { match: 'git ls-remote --heads origin', respond: 'abc123\trefs/heads/kahuna/42-wave-status-cli' },
    ]);

    const result = await handler.execute({
      plan_json: JSON.stringify({ phases: [] }),
      kahuna: { epic_id: 42, slug: 'wave-status-cli' },
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

  test('kahuna bootstrap — orphan refused: branch on remote but state empty', async () => {
    await setupStatusFixture({ kahuna_branch: null });
    setExecRoutes([
      { match: 'git remote get-url', respond: 'git@github.com:Wave-Engineering/mcp-server-sdlc.git' },
      { match: 'git ls-remote --heads origin', respond: 'abc123\trefs/heads/kahuna/42-orphan' },
    ]);

    const result = await handler.execute({
      plan_json: JSON.stringify({ phases: [] }),
      kahuna: { epic_id: 42, slug: 'orphan' },
    });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(false);
    expect(parsed.error as string).toContain('orphan');
    expect(parsed.error as string).toContain('kahuna/42-orphan');
  });

  test('kahuna bootstrap — state-mismatch refused: state has different branch', async () => {
    await setupStatusFixture({ kahuna_branch: 'kahuna/41-prior-epic' });
    setExecRoutes([
      { match: 'git remote get-url', respond: 'git@github.com:Wave-Engineering/mcp-server-sdlc.git' },
    ]);

    const result = await handler.execute({
      plan_json: JSON.stringify({ phases: [] }),
      kahuna: { epic_id: 42, slug: 'new-epic' },
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
      kahuna: { epic_id: 42, slug: 'foo' },
    });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(false);
    expect(parsed.error as string).toContain('missing from remote');
    expect(parsed.error as string).toContain('triage');
  });

  test('kahuna bootstrap — schema rejects uppercase or non-kebab slug', async () => {
    const result = await handler.execute({
      plan_json: JSON.stringify({ phases: [] }),
      kahuna: { epic_id: 42, slug: 'BadSlug' },
    });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error as string).toContain('kebab-case');
  });

  test('kahuna bootstrap — schema rejects non-positive epic_id', async () => {
    const result = await handler.execute({
      plan_json: JSON.stringify({ phases: [] }),
      kahuna: { epic_id: 0, slug: 'foo' },
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
      { match: "glab api projects/my-group%2Fmy-repo/repository/branches/'main'", respond: JSON.stringify({ commit: { id: '3333333333333333333333333333333333333333' } }) },
      { match: 'glab api projects/my-group%2Fmy-repo/repository/branches -X POST', respond: '' },
      { match: 'wave-status set-kahuna-branch', respond: '' },
    ]);

    const result = await handler.execute({
      plan_json: JSON.stringify({ phases: [] }),
      kahuna: { epic_id: 7, slug: 'feature-x' },
    });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.kahuna_branch).toBe('kahuna/7-feature-x');
    const calls = mockExecSync.mock.calls.map(c => c[0] as string);
    expect(calls.some(c => c.includes('glab api projects/my-group%2Fmy-repo/repository/branches -X POST'))).toBe(true);
    expect(calls.some(c => c.includes("branch='kahuna/7-feature-x'"))).toBe(true);
    expect(calls.some(c => c.includes("ref='3333333333333333333333333333333333333333'"))).toBe(true);
  });

  test('kahuna bootstrap — uses plan.base_branch when provided (default main)', async () => {
    await setupStatusFixture({ kahuna_branch: null });
    setExecRoutes([
      { match: 'git remote get-url', respond: 'git@github.com:org/repo.git' },
      { match: 'git ls-remote --heads origin', respond: '' },
      { match: "gh api repos/org/repo/branches/'develop'", respond: '1111111111111111111111111111111111111111' },
      { match: 'gh api repos/org/repo/git/refs', respond: '' },
      { match: 'wave-status set-kahuna-branch', respond: '' },
    ]);

    const result = await handler.execute({
      plan_json: JSON.stringify({ phases: [], base_branch: 'develop' }),
      kahuna: { epic_id: 99, slug: 'foo' },
    });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(true);
    const calls = mockExecSync.mock.calls.map(c => c[0] as string);
    expect(calls.some(c => c.includes("branches/'develop'"))).toBe(true);
    expect(calls.some(c => c.includes("sha='1111111111111111111111111111111111111111'"))).toBe(true);
  });

  test('kahuna bootstrap — gh api returns non-SHA garbage: defensive validator rejects', async () => {
    await setupStatusFixture({ kahuna_branch: null });
    setExecRoutes([
      { match: 'git remote get-url', respond: 'git@github.com:org/repo.git' },
      { match: 'git ls-remote --heads origin', respond: '' },
      // Could happen if the API shape changes or --jq returns null/empty.
      { match: "gh api repos/org/repo/branches/'main'", respond: 'null' },
    ]);

    const result = await handler.execute({
      plan_json: JSON.stringify({ phases: [] }),
      kahuna: { epic_id: 1, slug: 'foo' },
    });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error as string).toContain('unexpected SHA');
    // Critically, no branch creation attempted with the bogus SHA
    const calls = mockExecSync.mock.calls.map(c => c[0] as string);
    expect(calls.some(c => c.includes('git/refs -X POST'))).toBe(false);
  });

  test('kahuna bootstrap — gh api command does NOT use --repo flag (gh api is path-resolved)', async () => {
    await setupStatusFixture({ kahuna_branch: null });
    setExecRoutes([
      { match: 'git remote get-url', respond: 'git@github.com:org/repo.git' },
      { match: 'git ls-remote --heads origin', respond: '' },
      { match: "gh api repos/org/repo/branches/'main'", respond: '4444444444444444444444444444444444444444' },
      { match: 'gh api repos/org/repo/git/refs', respond: '' },
      { match: 'wave-status set-kahuna-branch', respond: '' },
    ]);

    await handler.execute({
      plan_json: JSON.stringify({ phases: [] }),
      kahuna: { epic_id: 1, slug: 'foo' },
    });

    // Regression: --repo is a porcelain flag, not valid on `gh api`.
    const calls = mockExecSync.mock.calls.map(c => c[0] as string);
    const ghApiCalls = calls.filter(c => c.includes('gh api'));
    for (const c of ghApiCalls) {
      expect(c).not.toContain('--repo');
    }
  });

  test('kahuna bootstrap — base_branch is shell-escaped in the URL path', async () => {
    await setupStatusFixture({ kahuna_branch: null });
    let capturedBaseCmd = '';
    setExecRoutes([
      { match: 'git remote get-url', respond: 'git@github.com:org/repo.git' },
      { match: 'git ls-remote --heads origin', respond: '' },
      // Match a benign substring; the test asserts the call shape after.
      { match: 'gh api repos/org/repo/branches/', respond: () => {
        capturedBaseCmd = mockExecSync.mock.calls[mockExecSync.mock.calls.length - 1][0] as string;
        return '5555555555555555555555555555555555555555';
      } },
      { match: 'gh api repos/org/repo/git/refs', respond: '' },
      { match: 'wave-status set-kahuna-branch', respond: '' },
    ]);

    await handler.execute({
      plan_json: JSON.stringify({ phases: [], base_branch: "weird; rm -rf /" }),
      kahuna: { epic_id: 1, slug: 'foo' },
    });

    // The malicious value must be wrapped in single quotes — proves shell escaping fires
    expect(capturedBaseCmd).toContain(`'weird; rm -rf /'`);
  });

  test('kahuna bootstrap — wave-status set-kahuna-branch failure surfaces as ok:false', async () => {
    await setupStatusFixture({ kahuna_branch: null });
    setExecRoutes([
      { match: 'git remote get-url', respond: 'git@github.com:org/repo.git' },
      { match: 'git ls-remote --heads origin', respond: '' },
      { match: "gh api repos/org/repo/branches/'main'", respond: '2222222222222222222222222222222222222222' },
      { match: 'gh api repos/org/repo/git/refs', respond: '' },
      { match: 'wave-status set-kahuna-branch', respond: () => { throw new Error('CLI exploded'); } },
    ]);

    const result = await handler.execute({
      plan_json: JSON.stringify({ phases: [] }),
      kahuna: { epic_id: 1, slug: 'foo' },
    });
    const parsed = parseResult(result);

    expect(parsed.ok).toBe(false);
    expect(parsed.error as string).toContain('set-kahuna-branch');
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
});
