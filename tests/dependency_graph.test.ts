import { describe, expect, test } from 'bun:test';
import { computeWaves, type DepNode } from '../lib/dependency_graph';

describe('computeWaves', () => {
  test('0 nodes: topology=serial, reason=no issues', () => {
    const result = computeWaves([]);
    expect(result.topology).toBe('serial');
    expect(result.reason).toBe('no issues');
    expect(result.total_issues).toBe(0);
    expect(result.waves.length).toBe(0);
    expect(result.error).toBeUndefined();
  });

  test('1 node, no deps: topology=serial, reason=single issue (trivial)', () => {
    const nodes: DepNode[] = [
      { ref: '#1', title: 'Issue 1', depends_on: [] },
    ];
    const result = computeWaves(nodes);
    expect(result.topology).toBe('serial');
    expect(result.reason).toBe('single issue (trivial)');
    expect(result.total_issues).toBe(1);
    expect(result.waves.length).toBe(1);
    expect(result.waves[0].issues.length).toBe(1);
    expect(result.error).toBeUndefined();
  });

  test('N nodes, no deps: topology=parallel, reason=no dependencies', () => {
    const nodes: DepNode[] = [
      { ref: '#1', title: 'Issue 1', depends_on: [] },
      { ref: '#2', title: 'Issue 2', depends_on: [] },
      { ref: '#3', title: 'Issue 3', depends_on: [] },
    ];
    const result = computeWaves(nodes);
    expect(result.topology).toBe('parallel');
    expect(result.reason).toBe('no dependencies');
    expect(result.total_issues).toBe(3);
    expect(result.waves.length).toBe(1);
    expect(result.waves[0].issues.length).toBe(3);
    expect(result.error).toBeUndefined();
  });

  test('N nodes, linear chain: topology=serial, reason=dependency chain forces ordering', () => {
    const nodes: DepNode[] = [
      { ref: '#1', title: 'Issue 1', depends_on: [] },
      { ref: '#2', title: 'Issue 2', depends_on: ['#1'] },
      { ref: '#3', title: 'Issue 3', depends_on: ['#2'] },
    ];
    const result = computeWaves(nodes);
    expect(result.topology).toBe('serial');
    expect(result.reason).toBe('dependency chain forces ordering');
    expect(result.total_issues).toBe(3);
    expect(result.waves.length).toBe(3);
    expect(result.waves[0].issues.length).toBe(1); // #1
    expect(result.waves[1].issues.length).toBe(1); // #2
    expect(result.waves[2].issues.length).toBe(1); // #3
    expect(result.error).toBeUndefined();
  });

  test('N nodes, diamond (parallel + serial mix): topology=mixed, reason=mixed parallelism and serial chains', () => {
    const nodes: DepNode[] = [
      { ref: '#1', title: 'Issue 1', depends_on: [] },
      { ref: '#2', title: 'Issue 2', depends_on: ['#1'] },
      { ref: '#3', title: 'Issue 3', depends_on: ['#1'] },
      { ref: '#4', title: 'Issue 4', depends_on: ['#2', '#3'] },
    ];
    const result = computeWaves(nodes);
    expect(result.topology).toBe('mixed');
    expect(result.reason).toBe('mixed parallelism and serial chains');
    expect(result.total_issues).toBe(4);
    expect(result.waves.length).toBe(3);
    expect(result.waves[0].issues.length).toBe(1); // #1
    expect(result.waves[1].issues.length).toBe(2); // #2, #3
    expect(result.waves[2].issues.length).toBe(1); // #4
    expect(result.error).toBeUndefined();
  });

  test('N nodes, cycle: topology=serial, reason=circular dependency detected, error set', () => {
    const nodes: DepNode[] = [
      { ref: '#1', title: 'Issue 1', depends_on: ['#2'] },
      { ref: '#2', title: 'Issue 2', depends_on: ['#1'] },
    ];
    const result = computeWaves(nodes);
    expect(result.topology).toBe('serial');
    expect(result.reason).toBe('circular dependency detected');
    expect(result.total_issues).toBe(2);
    expect(result.waves.length).toBe(0);
    expect(result.error).toContain('circular dependency detected');
    expect(result.error).toContain('#1');
    expect(result.error).toContain('#2');
  });
});
