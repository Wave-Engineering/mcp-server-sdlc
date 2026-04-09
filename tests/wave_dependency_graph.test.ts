import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';

let execMockFn: (cmd: string) => string = () => '';
const mockExecSync = mock((cmd: string, _opts?: unknown) => execMockFn(cmd));
mock.module('child_process', () => ({ execSync: mockExecSync }));

const { default: handler } = await import('../handlers/wave_dependency_graph.ts');

function resetMocks() {
  execMockFn = () => '';
  mockExecSync.mockClear();
}

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

function mockIssues(bodies: Record<string, string>, origin = 'https://github.com/org/repo.git') {
  execMockFn = (cmd: string) => {
    if (cmd.startsWith('git remote')) return origin + '\n';
    if (cmd.includes('gh issue view')) {
      const m = /gh issue view (\S+)/.exec(cmd);
      if (m) {
        const n = m[1];
        return JSON.stringify({ body: bodies[n] ?? '', title: `Issue ${n}` });
      }
    }
    return '';
  };
}

describe('wave_dependency_graph handler', () => {
  beforeEach(resetMocks);
  afterEach(resetMocks);

  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('wave_dependency_graph');
    expect(typeof handler.execute).toBe('function');
  });

  test('empty_graph — no issues returns empty nodes/edges', async () => {
    mockIssues({});
    const result = await handler.execute({ issue_refs: [] });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.nodes).toEqual([]);
    expect(parsed.edges).toEqual([]);
  });

  test('single_edge', async () => {
    mockIssues({
      '5': '## Dependencies\nNone\n',
      '6': '## Dependencies\n- #5\n',
    });
    const result = await handler.execute({ issue_refs: ['#5', '#6'] });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.reason).toBe('dependency chain forces ordering');
    expect(parsed.nodes.length).toBe(2);
    expect(parsed.edges.length).toBe(1);
    expect(parsed.edges[0].from).toBe('org/repo#5');
    expect(parsed.edges[0].to).toBe('org/repo#6');
    expect(parsed.edges[0].kind).toBe('blocks');
  });

  test('multiple_edges — diamond', async () => {
    mockIssues({
      '5': '## Dependencies\nNone\n',
      '6': '## Dependencies\nNone\n',
      '7': '## Dependencies\n- #5\n- #6\n',
      '8': '## Dependencies\n- #7\n',
    });
    const result = await handler.execute({ issue_refs: ['#5', '#6', '#7', '#8'] });
    const parsed = parseResult(result);
    expect(parsed.nodes.length).toBe(4);
    expect(parsed.edges.length).toBe(3);
  });

  test('disconnected_components — two independent islands', async () => {
    mockIssues({
      '5': '## Dependencies\nNone\n',
      '6': '## Dependencies\n- #5\n',
      '10': '## Dependencies\nNone\n',
      '11': '## Dependencies\n- #10\n',
    });
    const result = await handler.execute({ issue_refs: ['#5', '#6', '#10', '#11'] });
    const parsed = parseResult(result);
    expect(parsed.nodes.length).toBe(4);
    expect(parsed.edges.length).toBe(2);
  });

  test('cross_repo_nodes — org/repo#N preserved', async () => {
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote')) return 'https://github.com/org/repo.git\n';
      if (cmd.includes('gh issue view 5')) {
        return JSON.stringify({ body: '## Dependencies\n- acme/widgets#42\n', title: 'five' });
      }
      if (cmd.includes('gh issue view 42') && cmd.includes('--repo acme/widgets')) {
        return JSON.stringify({ body: '## Dependencies\nNone\n', title: 'external' });
      }
      return JSON.stringify({ body: '', title: '' });
    };
    const result = await handler.execute({ issue_refs: ['#5', 'acme/widgets#42'] });
    const parsed = parseResult(result);
    expect(parsed.nodes.some((n: { ref: string }) => n.ref === 'acme/widgets#42')).toBe(
      true,
    );
    expect(parsed.edges[0].from).toBe('acme/widgets#42');
    expect(parsed.edges[0].to).toBe('org/repo#5');
  });

  test('schema_validation — rejects both inputs', async () => {
    const result = await handler.execute({ issue_refs: ['#1'], epic_ref: '#2' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });

  test('fetched_count — all success', async () => {
    mockIssues({
      '5': '## Dependencies\nNone\n',
      '6': '## Dependencies\n- #5\n',
    });
    const result = await handler.execute({ issue_refs: ['#5', '#6'] });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.fetched_count).toBe(2);
    expect(parsed.warnings).toBeUndefined();
  });

  test('partial_failure — some fetches fail', async () => {
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote')) return 'https://github.com/org/repo.git\n';
      if (cmd.includes('gh issue view 5')) {
        return JSON.stringify({ body: '## Dependencies\nNone\n', title: 'Issue 5' });
      }
      if (cmd.includes('gh issue view 6')) {
        throw new Error('fetch failed for #6');
      }
      if (cmd.includes('gh issue view 7')) {
        return JSON.stringify({ body: '## Dependencies\nNone\n', title: 'Issue 7' });
      }
      return '';
    };
    const result = await handler.execute({ issue_refs: ['#5', '#6', '#7'] });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.fetched_count).toBe(2);
    expect(parsed.warnings).toBeDefined();
    expect(parsed.warnings.length).toBe(1);
    expect(parsed.warnings[0]).toContain('org/repo#6');
    expect(parsed.nodes.length).toBe(2);
  });

  test('total_failure — all fetches fail', async () => {
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote')) return 'https://github.com/org/repo.git\n';
      if (cmd.includes('gh issue view')) {
        throw new Error('fetch failed');
      }
      return '';
    };
    const result = await handler.execute({ issue_refs: ['#5', '#6'] });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.fetched_count).toBe(0);
    expect(parsed.issue_count).toBe(2);
    expect(parsed.error).toContain('all 2 spec fetches failed');
  });

  test('epic_ref_path_surfaces_errors_loudly', async () => {
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote')) return 'https://github.com/org/repo.git\n';
      if (cmd.includes('gh issue view 100')) {
        throw new Error('epic fetch failed');
      }
      return '';
    };
    const result = await handler.execute({ epic_ref: '#100' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('epic fetch failed');
  });
});
