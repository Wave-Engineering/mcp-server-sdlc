import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';

// Responder returns a string (probe stdout) when called. The function form
// receives the full cmd so tests can REJECT wrong-shape argv loudly per
// `lesson_origin_ops_pitfalls.md` — substring-only matching gave us false
// confidence twice this session (glab `--jq`, bare-hex `--color`).
type Responder = string | ((cmd: string) => string);

let execRegistry: Array<{ match: string; respond: Responder }> = [];
let execCalls: string[] = [];
let lastExecOpts: { timeout?: number; cwd?: string } | undefined;

function mockExec(cmd: string, opts?: { timeout?: number; cwd?: string }): string {
  execCalls.push(cmd);
  lastExecOpts = opts;
  for (const { match, respond } of execRegistry) {
    if (cmd.includes(match)) {
      return typeof respond === 'function' ? respond(cmd) : respond;
    }
  }
  throw new Error(`Unexpected exec call: ${cmd}`);
}

mock.module('child_process', () => ({
  execSync: (cmd: string, opts?: { timeout?: number; cwd?: string }) => mockExec(cmd, opts),
}));

const { default: handler } = await import('../handlers/commutativity_verify.ts');

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

function onExec(match: string, respond: Responder) {
  execRegistry.push({ match, respond });
}

// Throw a shaped error that mimics execSync on `command not found` via the
// POSIX shell exit-127 signal ONLY. Message intentionally generic so the
// regex-arm of probeMissing can NOT also fire — keeps the test isolated to
// status-detection per the false-confidence pitfall in
// `lesson_origin_ops_pitfalls.md`. Used by the canonical PROBE_UNAVAILABLE
// tests because exit-127 is the production path with execSync in shell mode.
function throwBinaryMissing(): never {
  const err = new Error('subprocess exited 127') as Error & { status?: number };
  err.status = 127;
  throw err;
}

// Throw a shaped error that mimics shells which don't propagate exit-127
// cleanly but still print the canonical "command not found" message. The
// message is the ONLY signal here (no status set) so this exercises the
// regex-arm of probeMissing in isolation.
function throwBinaryMissingShellMessage(): never {
  throw new Error('/bin/sh: 1: commutativity-probe: not found');
}

// Throw a shaped error that mimics a probe that ran but exited non-zero
// (a real probe bug). Distinct from binary-missing so we can prove the
// handler does NOT blanket-convert all subprocess errors to PROBE_UNAVAILABLE.
function throwProbeCrash(): never {
  const err = new Error('commutativity-probe analyze: AnalysisError: tree-sitter parse failed') as Error & { status?: number };
  err.status = 1;
  throw err;
}

function probeJson(verdict: string, pairs: Array<{
  a: string; b: string; verdict: string; reason: string;
  file_overlaps?: string[]; symbol_collisions?: string[]; import_overlaps?: string[];
}>): string {
  return JSON.stringify({
    changesets: pairs.length > 0 ? [pairs[0].a, pairs[0].b] : [],
    flight_verdict: verdict,
    pairs: pairs.map(p => ({
      a: p.a,
      b: p.b,
      verdict: p.verdict,
      reason: p.reason,
      file_overlaps: p.file_overlaps ?? [],
      symbol_collisions: p.symbol_collisions ?? [],
      import_overlaps: p.import_overlaps ?? [],
    })),
  });
}

beforeEach(() => {
  execRegistry = [];
  execCalls = [];
  lastExecOpts = undefined;
});

afterEach(() => {
  execRegistry = [];
  execCalls = [];
  lastExecOpts = undefined;
});

describe('commutativity_verify handler', () => {
  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('commutativity_verify');
    expect(typeof handler.execute).toBe('function');
  });

  // --- schema validation ---
  test('schema rejects empty changesets array (min: 1)', async () => {
    const result = await handler.execute({
      repo_path: '/repo',
      base_ref: 'main',
      changesets: [],
    });
    const data = parseResult(result);
    expect(data.ok).toBe(false);
    expect(data.error as string).toContain('1 changeset');
  });

  test('schema rejects missing repo_path', async () => {
    const result = await handler.execute({
      base_ref: 'main',
      changesets: [
        { id: 'mr-1', head_ref: 'feature/1' },
        { id: 'mr-2', head_ref: 'feature/2' },
      ],
    });
    const data = parseResult(result);
    expect(data.ok).toBe(false);
  });

  test('schema rejects empty changeset id', async () => {
    const result = await handler.execute({
      repo_path: '/repo',
      base_ref: 'main',
      changesets: [
        { id: '', head_ref: 'feature/1' },
        { id: 'mr-2', head_ref: 'feature/2' },
      ],
    });
    const data = parseResult(result);
    expect(data.ok).toBe(false);
  });

  // --- happy path: STRONG verdict ---
  test('STRONG verdict — file-disjoint and symbol-disjoint changesets', async () => {
    onExec('commutativity-probe', probeJson('STRONG', [{
      a: 'feature/1',
      b: 'feature/2',
      verdict: 'STRONG',
      reason: 'Syntactically disjoint and symbol-disjoint',
    }]));

    const result = await handler.execute({
      repo_path: '/repo',
      base_ref: 'main',
      changesets: [
        { id: 'mr-1', head_ref: 'feature/1' },
        { id: 'mr-2', head_ref: 'feature/2' },
      ],
    });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.group_verdict).toBe('STRONG');
    const pairs = data.pairs as Array<{ a: string; b: string; verdict: string }>;
    expect(pairs).toHaveLength(1);
    expect(pairs[0].a).toBe('mr-1');
    expect(pairs[0].b).toBe('mr-2');
    expect(pairs[0].verdict).toBe('STRONG');
  });

  // --- MEDIUM verdict ---
  test('MEDIUM verdict — import chain but no symbol cross-reference', async () => {
    onExec('commutativity-probe', probeJson('MEDIUM', [{
      a: 'feature/1',
      b: 'feature/2',
      verdict: 'MEDIUM',
      reason: 'Import chain overlap but no symbol cross-reference',
      import_overlaps: ['lib/shared.ts'],
    }]));

    const result = await handler.execute({
      repo_path: '/repo',
      base_ref: 'main',
      changesets: [
        { id: 'mr-1', head_ref: 'feature/1' },
        { id: 'mr-2', head_ref: 'feature/2' },
      ],
    });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.group_verdict).toBe('MEDIUM');
  });

  // --- WEAK verdict ---
  test('WEAK verdict — symbol cross-reference detected', async () => {
    onExec('commutativity-probe', probeJson('WEAK', [{
      a: 'feature/1',
      b: 'feature/2',
      verdict: 'WEAK',
      reason: 'Symbol cross-reference: processOrder modified by feature/1, referenced by feature/2',
      symbol_collisions: ['handlers/order.ts::processOrder'],
    }]));

    const result = await handler.execute({
      repo_path: '/repo',
      base_ref: 'main',
      changesets: [
        { id: 'mr-1', head_ref: 'feature/1' },
        { id: 'mr-2', head_ref: 'feature/2' },
      ],
    });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.group_verdict).toBe('WEAK');
    const pairs = data.pairs as Array<{ symbol_collisions: string[] }>;
    expect(pairs[0].symbol_collisions).toContain('handlers/order.ts::processOrder');
  });

  // --- ORACLE_REQUIRED verdict ---
  test('ORACLE_REQUIRED verdict — CI_INFRA file changed', async () => {
    onExec('commutativity-probe', probeJson('ORACLE_REQUIRED', [{
      a: 'feature/1',
      b: 'feature/2',
      verdict: 'ORACLE_REQUIRED',
      reason: 'CI_INFRA file changed: .github/workflows/ci.yml',
      file_overlaps: ['.github/workflows/ci.yml'],
    }]));

    const result = await handler.execute({
      repo_path: '/repo',
      base_ref: 'main',
      changesets: [
        { id: 'mr-1', head_ref: 'feature/1' },
        { id: 'mr-2', head_ref: 'feature/2' },
      ],
    });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.group_verdict).toBe('ORACLE_REQUIRED');
  });

  // --- probe binary missing (ENOENT / shell exit 127) → PROBE_UNAVAILABLE ---
  test('pairwise mode: ENOENT (binary missing) → PROBE_UNAVAILABLE with mirrored timeout shape', async () => {
    onExec('commutativity-probe', throwBinaryMissing);

    const result = await handler.execute({
      repo_path: '/repo',
      base_ref: 'main',
      changesets: [
        { id: 'mr-1', head_ref: 'feature/1' },
        { id: 'mr-2', head_ref: 'feature/2' },
      ],
    });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.mode).toBe('pairwise');
    expect(data.verdict).toBe('PROBE_UNAVAILABLE');
    expect(data.group_verdict).toBe('PROBE_UNAVAILABLE'); // legacy alias
    expect(data.pairs).toEqual([]);
    expect(data.pairwise_results).toEqual([]);
    expect(data.single_target_result).toBeUndefined();
    const warnings = data.warnings as string[];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('not found on PATH');
    expect(warnings[0]).toContain('install-remote.sh');
  });

  test('single-target mode: ENOENT (binary missing) → PROBE_UNAVAILABLE with single_target_result populated', async () => {
    onExec('commutativity-probe', throwBinaryMissing);

    const result = await handler.execute({
      repo_path: '/repo',
      base_ref: 'main',
      changesets: [{ id: 'kahuna', head_ref: 'kahuna/42-foo' }],
    });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.mode).toBe('single_target');
    expect(data.verdict).toBe('PROBE_UNAVAILABLE');
    expect(data.group_verdict).toBe('PROBE_UNAVAILABLE');
    expect(data.pairs).toEqual([]);
    expect(data.pairwise_results).toBeUndefined();
    const single = data.single_target_result as { verdict: string; changeset_id: string; head_ref: string };
    expect(single.verdict).toBe('PROBE_UNAVAILABLE');
    expect(single.changeset_id).toBe('kahuna');
    expect(single.head_ref).toBe('kahuna/42-foo');
  });

  // --- isolation: shell-message-only path also yields PROBE_UNAVAILABLE ---
  // Asserts the regex-arm of probeMissing fires independently of status===127.
  // If only one arm of the OR were left wired, this test would catch it (the
  // canonical throwBinaryMissing test would NOT — it sets status=127 and a
  // message that does NOT match the regex on purpose).
  test('shell-message-only (no status) — regex arm catches PROBE_UNAVAILABLE', async () => {
    onExec('commutativity-probe', throwBinaryMissingShellMessage);

    const result = await handler.execute({
      repo_path: '/repo',
      base_ref: 'main',
      changesets: [
        { id: 'mr-1', head_ref: 'feature/1' },
        { id: 'mr-2', head_ref: 'feature/2' },
      ],
    });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.verdict).toBe('PROBE_UNAVAILABLE');
  });

  // --- regression: probe-crash (non-ENOENT) MUST stay {ok:false} (#218) ---
  // Spec: only ENOENT becomes PROBE_UNAVAILABLE. Probe ran but exited
  // non-zero (real probe bug, malformed input, tree-sitter failure, etc.)
  // → still {ok:false} so we don't swallow real failures.
  test('probe-crash (non-ENOENT subprocess error) — keeps {ok:false} contract', async () => {
    onExec('commutativity-probe', throwProbeCrash);

    const result = await handler.execute({
      repo_path: '/repo',
      base_ref: 'main',
      changesets: [
        { id: 'mr-1', head_ref: 'feature/1' },
        { id: 'mr-2', head_ref: 'feature/2' },
      ],
    });
    const data = parseResult(result);

    expect(data.ok).toBe(false);
    expect(data.error as string).toContain('commutativity-probe failed');
    expect(data.error as string).toContain('tree-sitter parse failed');
    // Make sure we didn't synthesize a verdict for a real probe failure.
    expect(data.verdict).toBeUndefined();
    expect(data.group_verdict).toBeUndefined();
  });

  // --- argv-strictness: stub explicitly rejects wrong-shape commands ---
  // Per `lesson_origin_ops_pitfalls.md`: substring-only matching gave us
  // false confidence twice this session (glab `--jq`, bare-hex `--color`).
  // The handler must always invoke the probe with `analyze` + `--json` +
  // `--repo` + `--base`. If a refactor ever drops one of those flags, this
  // test fires immediately rather than passing silently.
  test('argv-strictness: stub rejects probe invocations missing required flags', async () => {
    onExec('commutativity-probe', (cmd) => {
      if (!/\bcommutativity-probe\s+analyze\b/.test(cmd)) {
        throw new Error(`Stub rejection: missing 'analyze' subcommand: ${cmd}`);
      }
      if (!cmd.includes('--json')) {
        throw new Error(`Stub rejection: missing --json flag: ${cmd}`);
      }
      // Word-boundary matches so a hypothetical future flag named --repository
      // or --baseline can't satisfy these checks accidentally.
      if (!/\s--repo\s/.test(cmd)) {
        throw new Error(`Stub rejection: missing --repo flag: ${cmd}`);
      }
      if (!/\s--base\s/.test(cmd)) {
        throw new Error(`Stub rejection: missing --base flag: ${cmd}`);
      }
      return probeJson('STRONG', [{
        a: 'feature/1', b: 'feature/2', verdict: 'STRONG', reason: 'Disjoint',
      }]);
    });

    const result = await handler.execute({
      repo_path: '/repo',
      base_ref: 'main',
      changesets: [
        { id: 'mr-1', head_ref: 'feature/1' },
        { id: 'mr-2', head_ref: 'feature/2' },
      ],
    });
    const data = parseResult(result);
    expect(data.ok).toBe(true);
    expect(data.verdict).toBe('STRONG');
  });

  // --- subprocess timeout ---
  test('subprocess timeout — returns ORACLE_REQUIRED (fail safe)', async () => {
    onExec('commutativity-probe', () => {
      throw new Error('ETIMEDOUT: command timed out');
    });

    const result = await handler.execute({
      repo_path: '/repo',
      base_ref: 'main',
      changesets: [
        { id: 'mr-1', head_ref: 'feature/1' },
        { id: 'mr-2', head_ref: 'feature/2' },
      ],
    });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.group_verdict).toBe('ORACLE_REQUIRED');
    const warnings = data.warnings as string[];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('timed out');
  });

  // --- malformed JSON from probe ---
  test('malformed JSON output — returns ok:false', async () => {
    onExec('commutativity-probe', 'this is not json');

    const result = await handler.execute({
      repo_path: '/repo',
      base_ref: 'main',
      changesets: [
        { id: 'mr-1', head_ref: 'feature/1' },
        { id: 'mr-2', head_ref: 'feature/2' },
      ],
    });
    const data = parseResult(result);

    expect(data.ok).toBe(false);
    expect(data.error as string).toContain('parse');
  });

  // --- unknown verdict from probe falls back to ORACLE_REQUIRED ---
  test('unknown verdict from probe — defaults to ORACLE_REQUIRED with warning', async () => {
    onExec('commutativity-probe', probeJson('BANANA', [{
      a: 'feature/1',
      b: 'feature/2',
      verdict: 'BANANA',
      reason: 'Something unexpected',
    }]));

    const result = await handler.execute({
      repo_path: '/repo',
      base_ref: 'main',
      changesets: [
        { id: 'mr-1', head_ref: 'feature/1' },
        { id: 'mr-2', head_ref: 'feature/2' },
      ],
    });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.group_verdict).toBe('ORACLE_REQUIRED');
    const warnings = data.warnings as string[];
    expect(warnings[0]).toContain('BANANA');
  });

  // --- verifies CLI command structure ---
  test('builds correct CLI command with repo, base, and branch refs', async () => {
    onExec('commutativity-probe', probeJson('STRONG', [{
      a: 'feature/alpha',
      b: 'feature/beta',
      verdict: 'STRONG',
      reason: 'Disjoint',
    }]));

    await handler.execute({
      repo_path: '/my/repo',
      base_ref: 'v1.0.0',
      changesets: [
        { id: 'mr-10', head_ref: 'feature/alpha' },
        { id: 'mr-11', head_ref: 'feature/beta' },
      ],
    });

    expect(execCalls).toHaveLength(1);
    const cmd = execCalls[0];
    expect(cmd).toContain('commutativity-probe analyze');
    expect(cmd).toContain("--repo '/my/repo'");
    expect(cmd).toContain("--base 'v1.0.0'");
    expect(cmd).toContain('--json');
    expect(cmd).toContain("'feature/alpha'");
    expect(cmd).toContain("'feature/beta'");
  });

  // --- shell escaping: spaces in repo path ---
  test('shell-escapes repo path with spaces', async () => {
    onExec('commutativity-probe', probeJson('STRONG', [{
      a: 'feature/a',
      b: 'feature/b',
      verdict: 'STRONG',
      reason: 'Disjoint',
    }]));

    await handler.execute({
      repo_path: '/my repo/with spaces',
      base_ref: 'main',
      changesets: [
        { id: 'mr-1', head_ref: 'feature/a' },
        { id: 'mr-2', head_ref: 'feature/b' },
      ],
    });

    const cmd = execCalls[0];
    expect(cmd).toContain("--repo '/my repo/with spaces'");
  });

  // --- new-shape fields in pairwise mode (backward-compat check) ---
  test('pairwise mode includes new `mode`/`verdict`/`pairwise_results` fields alongside legacy aliases', async () => {
    onExec('commutativity-probe', probeJson('MEDIUM', [{
      a: 'feature/1',
      b: 'feature/2',
      verdict: 'MEDIUM',
      reason: 'Overlap',
    }]));

    const result = await handler.execute({
      repo_path: '/repo',
      base_ref: 'main',
      changesets: [
        { id: 'mr-1', head_ref: 'feature/1' },
        { id: 'mr-2', head_ref: 'feature/2' },
      ],
    });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.mode).toBe('pairwise');
    expect(data.verdict).toBe('MEDIUM');
    expect(data.group_verdict).toBe('MEDIUM'); // legacy alias preserved
    const pairwise = data.pairwise_results as Array<{ a: string; b: string }>;
    expect(pairwise).toHaveLength(1);
    expect(pairwise[0].a).toBe('mr-1');
    expect(data.pairs).toEqual(data.pairwise_results); // same content
    expect(data.single_target_result).toBeUndefined();
  });

  // --- single-target mode: STRONG verdict (clean change) ---
  test('single-target mode: STRONG verdict — clean branch safe to land', async () => {
    // Probe emits empty pairs and a flight-level verdict for single-changeset invocations.
    onExec('commutativity-probe', JSON.stringify({
      changesets: ['kahuna/42-foo'],
      flight_verdict: 'STRONG',
      pairs: [],
    }));

    const result = await handler.execute({
      repo_path: '/repo',
      base_ref: 'main',
      changesets: [{ id: 'kahuna', head_ref: 'kahuna/42-foo' }],
    });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.mode).toBe('single_target');
    expect(data.verdict).toBe('STRONG');
    expect(data.group_verdict).toBe('STRONG'); // legacy alias
    expect(data.pairs).toEqual([]);
    expect(data.pairwise_results).toBeUndefined();
    const single = data.single_target_result as { verdict: string; changeset_id: string; head_ref: string };
    expect(single.verdict).toBe('STRONG');
    expect(single.changeset_id).toBe('kahuna');
    expect(single.head_ref).toBe('kahuna/42-foo');
  });

  // --- single-target mode: ORACLE_REQUIRED (probe fires CI_INFRA gate) ---
  test('single-target mode: ORACLE_REQUIRED — probe flags CI_INFRA risk', async () => {
    onExec('commutativity-probe', JSON.stringify({
      changesets: ['kahuna/43-ci-infra'],
      flight_verdict: 'ORACLE_REQUIRED',
      pairs: [],
    }));

    const result = await handler.execute({
      repo_path: '/repo',
      base_ref: 'main',
      changesets: [{ id: 'kahuna', head_ref: 'kahuna/43-ci-infra' }],
    });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.mode).toBe('single_target');
    expect(data.verdict).toBe('ORACLE_REQUIRED');
    const single = data.single_target_result as { verdict: string };
    expect(single.verdict).toBe('ORACLE_REQUIRED');
  });

  // --- defensive: single-target with unexpected non-empty pairs from probe ---
  test('single-target mode: discards unexpected pairs from probe and warns', async () => {
    // Hypothetical future probe output that breaks the single-target contract.
    onExec('commutativity-probe', JSON.stringify({
      changesets: ['kahuna/42-foo'],
      flight_verdict: 'STRONG',
      pairs: [{
        a: 'kahuna/42-foo',
        b: 'kahuna/42-foo',
        verdict: 'STRONG',
        reason: 'self-pair (unexpected)',
        file_overlaps: [],
        symbol_collisions: [],
        import_overlaps: [],
      }],
    }));

    const result = await handler.execute({
      repo_path: '/repo',
      base_ref: 'main',
      changesets: [{ id: 'kahuna', head_ref: 'kahuna/42-foo' }],
    });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.mode).toBe('single_target');
    expect(data.pairs).toEqual([]); // defensively emptied
    expect(data.pairwise_results).toBeUndefined();
    const warnings = data.warnings as string[];
    expect(warnings.some(w => w.includes('single-target'))).toBe(true);
  });

  // --- single-target mode: probe command structure ---
  test('single-target mode: CLI command includes one branch, same flags', async () => {
    onExec('commutativity-probe', JSON.stringify({
      changesets: ['kahuna/42-foo'],
      flight_verdict: 'STRONG',
      pairs: [],
    }));

    await handler.execute({
      repo_path: '/repo',
      base_ref: 'main',
      changesets: [{ id: 'kahuna', head_ref: 'kahuna/42-foo' }],
    });

    expect(execCalls).toHaveLength(1);
    const cmd = execCalls[0];
    expect(cmd).toContain('commutativity-probe analyze');
    expect(cmd).toContain("--repo '/repo'");
    expect(cmd).toContain("--base 'main'");
    expect(cmd).toContain("'kahuna/42-foo'");
  });

  // --- single-target mode: subprocess timeout fails safe ---
  test('single-target mode: timeout returns ORACLE_REQUIRED with single_target_result populated', async () => {
    onExec('commutativity-probe', () => {
      throw new Error('ETIMEDOUT: command timed out');
    });

    const result = await handler.execute({
      repo_path: '/repo',
      base_ref: 'main',
      changesets: [{ id: 'kahuna', head_ref: 'kahuna/42-foo' }],
    });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.mode).toBe('single_target');
    expect(data.verdict).toBe('ORACLE_REQUIRED');
    const single = data.single_target_result as { verdict: string; changeset_id: string };
    expect(single.verdict).toBe('ORACLE_REQUIRED');
    expect(single.changeset_id).toBe('kahuna');
    expect(data.pairwise_results).toBeUndefined();
  });

  // --- timeout_sec parameter override ---
  test('timeout_sec parameter overrides the default (30s) subprocess timeout', async () => {
    onExec('commutativity-probe', JSON.stringify({
      changesets: ['feature/1'],
      flight_verdict: 'STRONG',
      pairs: [],
    }));

    await handler.execute({
      repo_path: '/repo',
      base_ref: 'main',
      changesets: [{ id: 'kahuna', head_ref: 'feature/1' }],
      timeout_sec: 5,
    });

    expect(lastExecOpts?.timeout).toBe(5_000);
  });

  test('default timeout (30s) used when timeout_sec omitted', async () => {
    onExec('commutativity-probe', JSON.stringify({
      changesets: ['feature/1'],
      flight_verdict: 'STRONG',
      pairs: [],
    }));

    await handler.execute({
      repo_path: '/repo',
      base_ref: 'main',
      changesets: [{ id: 'kahuna', head_ref: 'feature/1' }],
    });

    expect(lastExecOpts?.timeout).toBe(30_000);
  });

  // --- three changesets produce correct pair count ---
  test('three changesets — maps all three pair IDs correctly', async () => {
    const pairs = [
      { a: 'feature/a', b: 'feature/b', verdict: 'STRONG', reason: 'Disjoint' },
      { a: 'feature/a', b: 'feature/c', verdict: 'STRONG', reason: 'Disjoint' },
      { a: 'feature/b', b: 'feature/c', verdict: 'WEAK', reason: 'File overlap' },
    ];
    onExec('commutativity-probe', JSON.stringify({
      changesets: ['feature/a', 'feature/b', 'feature/c'],
      flight_verdict: 'WEAK',
      pairs: pairs.map(p => ({ ...p, file_overlaps: [], symbol_collisions: [], import_overlaps: [] })),
    }));

    const result = await handler.execute({
      repo_path: '/repo',
      base_ref: 'main',
      changesets: [
        { id: 'mr-1', head_ref: 'feature/a' },
        { id: 'mr-2', head_ref: 'feature/b' },
        { id: 'mr-3', head_ref: 'feature/c' },
      ],
    });
    const data = parseResult(result);

    expect(data.ok).toBe(true);
    expect(data.group_verdict).toBe('WEAK');
    const resultPairs = data.pairs as Array<{ a: string; b: string; verdict: string }>;
    expect(resultPairs).toHaveLength(3);
    // Verify ref→id mapping
    expect(resultPairs[0].a).toBe('mr-1');
    expect(resultPairs[0].b).toBe('mr-2');
    expect(resultPairs[2].a).toBe('mr-2');
    expect(resultPairs[2].b).toBe('mr-3');
    expect(resultPairs[2].verdict).toBe('WEAK');
  });
});
