import { describe, test, expect } from 'bun:test';

const { runPredict, default: handler } = await import(
  '../handlers/commutativity_predict.ts'
);

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe('commutativity_predict handler', () => {
  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('commutativity_predict');
    expect(typeof handler.execute).toBe('function');
  });

  test('STRONG verdict — file-disjoint changesets', async () => {
    const deps = {
      execFn: (_cmd: string, _input: string) =>
        JSON.stringify({
          changesets: ['#1', '#2'],
          flight_verdict: 'STRONG',
          pairs: [
            {
              a: '#1',
              b: '#2',
              verdict: 'STRONG',
              reason: 'No file, symbol, or import coupling detected',
              file_overlaps: [],
              symbol_collisions: [],
              import_overlaps: [],
            },
          ],
        }),
    };

    const result = await runPredict(
      {
        changesets: [
          { id: '#1', files: [{ path: 'src/a.ts', action: 'modify' }] },
          { id: '#2', files: [{ path: 'src/b.ts', action: 'modify' }] },
        ],
      },
      deps,
    );

    expect(result.ok).toBe(true);
    expect(result.group_verdict).toBe('STRONG');
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs![0].verdict).toBe('STRONG');
  });

  test('MEDIUM verdict — dependency manifest overlap', async () => {
    const deps = {
      execFn: (_cmd: string, _input: string) =>
        JSON.stringify({
          changesets: ['#1', '#2'],
          flight_verdict: 'MEDIUM',
          pairs: [
            {
              a: '#1',
              b: '#2',
              verdict: 'MEDIUM',
              reason: 'Dependency manifest overlap only: Cargo.toml',
              file_overlaps: ['Cargo.toml'],
              symbol_collisions: [],
              import_overlaps: [],
            },
          ],
        }),
    };

    const result = await runPredict(
      {
        changesets: [
          {
            id: '#1',
            files: [
              { path: 'Cargo.toml', action: 'modify' },
              { path: 'src/a.rs', action: 'create' },
            ],
          },
          {
            id: '#2',
            files: [
              { path: 'Cargo.toml', action: 'modify' },
              { path: 'src/b.rs', action: 'create' },
            ],
          },
        ],
      },
      deps,
    );

    expect(result.ok).toBe(true);
    expect(result.group_verdict).toBe('MEDIUM');
  });

  test('WEAK verdict — source file overlap', async () => {
    const deps = {
      execFn: (_cmd: string, _input: string) =>
        JSON.stringify({
          changesets: ['#1', '#2'],
          flight_verdict: 'WEAK',
          pairs: [
            {
              a: '#1',
              b: '#2',
              verdict: 'WEAK',
              reason: 'File overlap: src/shared.ts',
              file_overlaps: ['src/shared.ts'],
              symbol_collisions: [],
              import_overlaps: [],
            },
          ],
        }),
    };

    const result = await runPredict(
      {
        changesets: [
          { id: '#1', files: [{ path: 'src/shared.ts', action: 'modify' }] },
          { id: '#2', files: [{ path: 'src/shared.ts', action: 'modify' }] },
        ],
      },
      deps,
    );

    expect(result.ok).toBe(true);
    expect(result.group_verdict).toBe('WEAK');
  });

  test('ORACLE_REQUIRED verdict — CI infra', async () => {
    const deps = {
      execFn: (_cmd: string, _input: string) =>
        JSON.stringify({
          changesets: ['#1', '#2'],
          flight_verdict: 'ORACLE_REQUIRED',
          pairs: [
            {
              a: '#1',
              b: '#2',
              verdict: 'ORACLE_REQUIRED',
              reason: 'CI_INFRA file(s) in: #1',
              file_overlaps: [],
              symbol_collisions: [],
              import_overlaps: [],
            },
          ],
        }),
    };

    const result = await runPredict(
      {
        changesets: [
          {
            id: '#1',
            files: [{ path: '.github/workflows/ci.yml', action: 'modify' }],
          },
          { id: '#2', files: [{ path: 'src/b.ts', action: 'modify' }] },
        ],
      },
      deps,
    );

    expect(result.ok).toBe(true);
    expect(result.group_verdict).toBe('ORACLE_REQUIRED');
  });

  test('subprocess timeout — fails safe to ORACLE_REQUIRED', async () => {
    const deps = {
      execFn: (_cmd: string, _input: string) => {
        throw new Error('timed out after 10000ms');
      },
    };

    const result = await runPredict(
      {
        changesets: [
          { id: '#1', files: [{ path: 'a.ts' }] },
          { id: '#2', files: [{ path: 'b.ts' }] },
        ],
      },
      deps,
    );

    expect(result.ok).toBe(true);
    expect(result.group_verdict).toBe('ORACLE_REQUIRED');
    expect(result.warnings).toBeDefined();
    expect(result.warnings![0]).toContain('timed out');
  });

  test('subprocess error — returns ok:false', async () => {
    const deps = {
      execFn: (_cmd: string, _input: string) => {
        throw new Error('commutativity-probe: command not found');
      },
    };

    const result = await runPredict(
      {
        changesets: [
          { id: '#1', files: [{ path: 'a.ts' }] },
          { id: '#2', files: [{ path: 'b.ts' }] },
        ],
      },
      deps,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('commutativity-probe predict failed');
  });

  test('malformed JSON from probe — returns ok:false', async () => {
    const deps = {
      execFn: (_cmd: string, _input: string) => 'not valid json {{{',
    };

    const result = await runPredict(
      {
        changesets: [
          { id: '#1', files: [{ path: 'a.ts' }] },
          { id: '#2', files: [{ path: 'b.ts' }] },
        ],
      },
      deps,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Failed to parse');
  });

  test('schema validation — rejects fewer than 2 changesets', async () => {
    const result = await runPredict({
      changesets: [{ id: '#1', files: [{ path: 'a.ts' }] }],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('2 changesets');
  });

  test('unknown verdict from probe — defaults to ORACLE_REQUIRED', async () => {
    const deps = {
      execFn: (_cmd: string, _input: string) =>
        JSON.stringify({
          changesets: ['#1', '#2'],
          flight_verdict: 'UNKNOWN_VERDICT',
          pairs: [],
        }),
    };

    const result = await runPredict(
      {
        changesets: [
          { id: '#1', files: [{ path: 'a.ts' }] },
          { id: '#2', files: [{ path: 'b.ts' }] },
        ],
      },
      deps,
    );

    expect(result.ok).toBe(true);
    expect(result.group_verdict).toBe('ORACLE_REQUIRED');
    expect(result.warnings).toBeDefined();
  });
});
