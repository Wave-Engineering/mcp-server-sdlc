import { describe, test, expect } from 'bun:test';

import { classifyFile } from '../lib/flight_overlap';

const { default: handler } = await import('../handlers/flight_overlap.ts');

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe('classifyFile', () => {
  test('Cargo.toml → DEPENDENCY_MANIFEST', () => {
    expect(classifyFile('Cargo.toml')).toBe('DEPENDENCY_MANIFEST');
    expect(classifyFile('crates/foo/Cargo.toml')).toBe('DEPENDENCY_MANIFEST');
  });

  test('Cargo.lock → DEPENDENCY_MANIFEST', () => {
    expect(classifyFile('Cargo.lock')).toBe('DEPENDENCY_MANIFEST');
  });

  test('package.json, package-lock.json, yarn.lock, pnpm-lock.yaml → DEPENDENCY_MANIFEST', () => {
    expect(classifyFile('package.json')).toBe('DEPENDENCY_MANIFEST');
    expect(classifyFile('package-lock.json')).toBe('DEPENDENCY_MANIFEST');
    expect(classifyFile('yarn.lock')).toBe('DEPENDENCY_MANIFEST');
    expect(classifyFile('pnpm-lock.yaml')).toBe('DEPENDENCY_MANIFEST');
  });

  test('go.mod, go.sum → DEPENDENCY_MANIFEST', () => {
    expect(classifyFile('go.mod')).toBe('DEPENDENCY_MANIFEST');
    expect(classifyFile('go.sum')).toBe('DEPENDENCY_MANIFEST');
  });

  test('pyproject.toml, poetry.lock, requirements.txt → DEPENDENCY_MANIFEST', () => {
    expect(classifyFile('pyproject.toml')).toBe('DEPENDENCY_MANIFEST');
    expect(classifyFile('poetry.lock')).toBe('DEPENDENCY_MANIFEST');
    expect(classifyFile('requirements.txt')).toBe('DEPENDENCY_MANIFEST');
  });

  test('Gemfile, Gemfile.lock → DEPENDENCY_MANIFEST', () => {
    expect(classifyFile('Gemfile')).toBe('DEPENDENCY_MANIFEST');
    expect(classifyFile('Gemfile.lock')).toBe('DEPENDENCY_MANIFEST');
  });

  test('source files → ANALYZABLE', () => {
    expect(classifyFile('src/main.ts')).toBe('ANALYZABLE');
    expect(classifyFile('lib/utils.py')).toBe('ANALYZABLE');
    expect(classifyFile('README.md')).toBe('ANALYZABLE');
  });
});

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

  test('single_pair_overlap — shared source file creates one conflict with overlap_type source', async () => {
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
    expect(parsed.conflicts[0].overlap_type).toBe('source');
    // Source overlap → serialized: #1 and #3 in grp1, #2 in grp2
    expect(parsed.conflict_free_groups.length).toBe(2);
  });

  test('manifest_only_overlap — shared Cargo.toml → same group (discounted)', async () => {
    const result = await handler.execute({
      manifests: [
        { issue_ref: '#1', files_to_modify: ['Cargo.toml', 'src/a.rs'] },
        { issue_ref: '#2', files_to_modify: ['Cargo.toml', 'src/b.rs'] },
      ],
    });
    const parsed = parseResult(result);
    expect(parsed.conflicts).toHaveLength(1);
    expect(parsed.conflicts[0].overlap_type).toBe('manifest_only');
    // Manifest-only overlap is discounted → single group
    expect(parsed.conflict_free_groups).toHaveLength(1);
    expect(parsed.conflict_free_groups[0]).toEqual(['#1', '#2']);
  });

  test('mixed_overlap — shared source + manifest → separate groups', async () => {
    const result = await handler.execute({
      manifests: [
        { issue_ref: '#1', files_to_modify: ['Cargo.toml', 'src/lib.rs'] },
        { issue_ref: '#2', files_to_modify: ['Cargo.toml', 'src/lib.rs'] },
      ],
    });
    const parsed = parseResult(result);
    expect(parsed.conflicts).toHaveLength(1);
    expect(parsed.conflicts[0].overlap_type).toBe('mixed');
    // Mixed overlap is NOT discounted → separate groups
    expect(parsed.conflict_free_groups).toHaveLength(2);
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
    expect(parsed.conflicts[0].overlap_type).toBe('source');
    expect(parsed.conflicts[1].overlap_type).toBe('source');
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
