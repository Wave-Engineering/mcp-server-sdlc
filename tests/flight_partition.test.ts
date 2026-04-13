import { describe, test, expect } from 'bun:test';

const { default: handler } = await import('../handlers/flight_partition.ts');

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe('flight_partition handler', () => {
  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('flight_partition');
    expect(typeof handler.execute).toBe('function');
  });

  test('all_independent_single_flight — no conflicts → 1 flight with all issues', async () => {
    const result = await handler.execute({
      manifests: [
        { issue_ref: '#1', files_to_create: ['a.ts'] },
        { issue_ref: '#2', files_to_create: ['b.ts'] },
        { issue_ref: '#3', files_to_create: ['c.ts'] },
      ],
    });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.flights.length).toBe(1);
    expect(parsed.flights[0].issues).toEqual(['#1', '#2', '#3']);
    expect(parsed.flights[0].reason).toContain('conflict-free');
  });

  test('all_conflict_sequential_flights — every pair conflicts → 1 issue per flight', async () => {
    const result = await handler.execute({
      manifests: [
        { issue_ref: '#1', files_to_modify: ['shared.ts'] },
        { issue_ref: '#2', files_to_modify: ['shared.ts'] },
        { issue_ref: '#3', files_to_modify: ['shared.ts'] },
      ],
    });
    const parsed = parseResult(result);
    expect(parsed.flights.length).toBe(3);
    expect(parsed.flights.every((f: { issues: string[] }) => f.issues.length === 1)).toBe(true);
    expect(parsed.conflict_count).toBe(3);
  });

  test('mixed_partitioning — partial conflict graph', async () => {
    // #1 and #2 conflict on shared.ts, #3 is independent, #4 conflicts with #3
    const result = await handler.execute({
      manifests: [
        { issue_ref: '#1', files_to_modify: ['shared.ts'] },
        { issue_ref: '#2', files_to_modify: ['shared.ts'] },
        { issue_ref: '#3', files_to_modify: ['other.ts'] },
        { issue_ref: '#4', files_to_modify: ['other.ts'] },
      ],
    });
    const parsed = parseResult(result);
    // Greedy: #1 → flight 1; #2 conflicts → flight 2; #3 doesn't conflict with #1 → flight 1; #4 conflicts with #3 → flight 2
    expect(parsed.flights.length).toBe(2);
    expect(parsed.flights[0].issues).toContain('#1');
    expect(parsed.flights[0].issues).toContain('#3');
    expect(parsed.flights[1].issues).toContain('#2');
    expect(parsed.flights[1].issues).toContain('#4');
  });

  test('empty_input_returns_empty', async () => {
    const result = await handler.execute({ manifests: [] });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.flights).toEqual([]);
    expect(parsed.conflict_count).toBe(0);
  });

  test('preserves_input_order_within_flights', async () => {
    const result = await handler.execute({
      manifests: [
        { issue_ref: '#10', files_to_create: ['a.ts'] },
        { issue_ref: '#3', files_to_create: ['b.ts'] },
        { issue_ref: '#7', files_to_create: ['c.ts'] },
      ],
    });
    const parsed = parseResult(result);
    expect(parsed.flights[0].issues).toEqual(['#10', '#3', '#7']);
  });

  test('manifest_only_overlap_single_flight — Cargo.toml overlap discounted', async () => {
    const result = await handler.execute({
      manifests: [
        { issue_ref: '#1', files_to_modify: ['Cargo.toml', 'Cargo.lock', 'src/a.rs'] },
        { issue_ref: '#2', files_to_modify: ['Cargo.toml', 'Cargo.lock', 'src/b.rs'] },
      ],
    });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    // Manifest-only overlap is discounted → single flight
    expect(parsed.flights.length).toBe(1);
    expect(parsed.flights[0].issues).toEqual(['#1', '#2']);
  });

  test('source_overlap_multiple_flights — source file overlap NOT discounted', async () => {
    const result = await handler.execute({
      manifests: [
        { issue_ref: '#1', files_to_modify: ['package.json', 'src/shared.ts'] },
        { issue_ref: '#2', files_to_modify: ['package.json', 'src/shared.ts'] },
      ],
    });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    // Mixed overlap (source + manifest) → separate flights
    expect(parsed.flights.length).toBe(2);
  });

  test('file_classifications_param_accepted', async () => {
    const result = await handler.execute({
      manifests: [
        { issue_ref: '#1', files_to_modify: ['a.ts'] },
      ],
      file_classifications: { 'a.ts': 'ANALYZABLE' },
    });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.flights.length).toBe(1);
  });

  test('aggressive_strategy — currently equivalent to safe (v1)', async () => {
    const result = await handler.execute({
      manifests: [
        { issue_ref: '#1', files_to_modify: ['a.ts'] },
        { issue_ref: '#2', files_to_modify: ['a.ts'] },
      ],
      strategy: 'aggressive',
    });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.strategy_used).toBe('aggressive');
    expect(parsed.flights.length).toBe(2);
  });

  test('schema_validation — rejects invalid strategy', async () => {
    const result = await handler.execute({
      manifests: [],
      strategy: 'yolo',
    });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });
});
