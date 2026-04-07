import { describe, test, expect } from 'bun:test';

const { default: handler } = await import('../handlers/flight_overlap.ts');

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe('flight_overlap handler', () => {
  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('flight_overlap');
    expect(typeof handler.execute).toBe('function');
  });

  test('no_overlap_returns_empty_conflicts', async () => {
    const result = await handler.execute({
      manifests: [
        { issue_ref: '#1', files_to_create: ['a.ts'] },
        { issue_ref: '#2', files_to_create: ['b.ts'] },
        { issue_ref: '#3', files_to_modify: ['c.ts'] },
      ],
    });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.conflicts).toEqual([]);
    expect(parsed.conflict_free_groups).toHaveLength(1);
    expect(parsed.conflict_free_groups[0]).toEqual(['#1', '#2', '#3']);
  });

  test('single_pair_overlap — shared file creates one conflict', async () => {
    const result = await handler.execute({
      manifests: [
        { issue_ref: '#1', files_to_modify: ['shared.ts'] },
        { issue_ref: '#2', files_to_modify: ['shared.ts'] },
        { issue_ref: '#3', files_to_create: ['unique.ts'] },
      ],
    });
    const parsed = parseResult(result);
    expect(parsed.conflicts).toHaveLength(1);
    expect(parsed.conflicts[0].a).toBe('#1');
    expect(parsed.conflicts[0].b).toBe('#2');
    expect(parsed.conflicts[0].files).toEqual(['shared.ts']);
    expect(parsed.conflicts[0].severity).toBe('hard');
    // Groups: #1 in first, #2 in second, #3 can fit in first (no conflict with #1)
    expect(parsed.conflict_free_groups.length).toBe(2);
  });

  test('transitive_chain — A↔B, B↔C but A!↔C → two groups', async () => {
    const result = await handler.execute({
      manifests: [
        { issue_ref: '#A', files_to_modify: ['ab.ts'] },
        { issue_ref: '#B', files_to_modify: ['ab.ts', 'bc.ts'] },
        { issue_ref: '#C', files_to_modify: ['bc.ts'] },
      ],
    });
    const parsed = parseResult(result);
    expect(parsed.conflicts).toHaveLength(2);
    // Greedy grouping: A in grp1, B conflicts with A → grp2, C conflicts with B → grp1 (no conflict with A)
    expect(parsed.conflict_free_groups.length).toBe(2);
    expect(parsed.conflict_free_groups[0]).toContain('#A');
    expect(parsed.conflict_free_groups[0]).toContain('#C');
    expect(parsed.conflict_free_groups[1]).toContain('#B');
  });

  test('conflict_free_groups_maximize_parallelism — all independent → single group', async () => {
    const result = await handler.execute({
      manifests: [
        { issue_ref: '#1', files_to_create: ['a.ts'] },
        { issue_ref: '#2', files_to_create: ['b.ts'] },
        { issue_ref: '#3', files_to_create: ['c.ts'] },
        { issue_ref: '#4', files_to_create: ['d.ts'] },
      ],
    });
    const parsed = parseResult(result);
    expect(parsed.conflicts).toEqual([]);
    expect(parsed.conflict_free_groups).toEqual([['#1', '#2', '#3', '#4']]);
  });

  test('empty_manifests_returns_empty_state', async () => {
    const result = await handler.execute({ manifests: [] });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.conflicts).toEqual([]);
    expect(parsed.conflict_free_groups).toEqual([]);
  });

  test('schema_validation — rejects missing manifests', async () => {
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });

  test('schema_validation — rejects manifest without issue_ref', async () => {
    const result = await handler.execute({
      manifests: [{ files_to_create: ['a.ts'] }],
    });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });
});
