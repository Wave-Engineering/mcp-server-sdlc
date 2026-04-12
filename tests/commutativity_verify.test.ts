import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';

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

const { default: handler } = await import('../handlers/commutativity_verify.ts');

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

function onExec(match: string, respond: Responder) {
  execRegistry.push({ match, respond });
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
});

afterEach(() => {
  execRegistry = [];
  execCalls = [];
});

describe('commutativity_verify handler', () => {
  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('commutativity_verify');
    expect(typeof handler.execute).toBe('function');
  });

  // --- schema validation ---
  test('schema rejects single changeset (minItems: 2)', async () => {
    const result = await handler.execute({
      repo_path: '/repo',
      base_ref: 'main',
      changesets: [{ id: 'mr-1', head_ref: 'feature/1' }],
    });
    const data = parseResult(result);
    expect(data.ok).toBe(false);
    expect(data.error as string).toContain('2 changesets');
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

  // --- subprocess error ---
  test('subprocess error — returns ok:false with error message', async () => {
    onExec('commutativity-probe', () => {
      throw new Error('commutativity-probe: command not found');
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

    expect(data.ok).toBe(false);
    expect(data.error as string).toContain('commutativity-probe failed');
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
    expect(cmd).toContain('--repo /my/repo');
    expect(cmd).toContain('--base v1.0.0');
    expect(cmd).toContain('--json');
    expect(cmd).toContain('feature/alpha');
    expect(cmd).toContain('feature/beta');
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
