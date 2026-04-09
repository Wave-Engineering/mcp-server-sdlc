import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';

let execMockFn: (cmd: string) => string = () => '';
const mockExecSync = mock((cmd: string, _opts?: unknown) => execMockFn(cmd));
mock.module('child_process', () => ({ execSync: mockExecSync }));

const { default: handler } = await import('../handlers/wave_topology.ts');

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

describe('wave_topology handler', () => {
  beforeEach(resetMocks);
  afterEach(resetMocks);

  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('wave_topology');
    expect(typeof handler.execute).toBe('function');
  });

  test('linear_chain_serial', async () => {
    mockIssues({
      '5': '## Dependencies\nNone\n',
      '6': '## Dependencies\n- #5\n',
      '7': '## Dependencies\n- #6\n',
    });
    const result = await handler.execute({ issue_refs: ['#5', '#6', '#7'] });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.topology).toBe('serial');
    expect(parsed.wave_count).toBe(3);
    expect(parsed.max_parallelism).toBe(1);
  });

  test('independent_issues_parallel', async () => {
    mockIssues({
      '5': '## Dependencies\nNone\n',
      '6': '## Dependencies\nNone\n',
      '7': '## Dependencies\nNone\n',
    });
    const result = await handler.execute({ issue_refs: ['#5', '#6', '#7'] });
    const parsed = parseResult(result);
    expect(parsed.topology).toBe('parallel');
    expect(parsed.wave_count).toBe(1);
    expect(parsed.max_parallelism).toBe(3);
  });

  test('mixed_topology — parallel then serial', async () => {
    mockIssues({
      '5': '## Dependencies\nNone\n',
      '6': '## Dependencies\nNone\n',
      '7': '## Dependencies\n- #5\n- #6\n',
    });
    const result = await handler.execute({ issue_refs: ['#5', '#6', '#7'] });
    const parsed = parseResult(result);
    expect(parsed.topology).toBe('mixed');
    expect(parsed.wave_count).toBe(2);
    expect(parsed.max_parallelism).toBe(2);
  });

  test('single_issue — serial with wave_count=1', async () => {
    mockIssues({ '5': '## Dependencies\nNone\n' });
    const result = await handler.execute({ issue_refs: ['#5'] });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.wave_count).toBe(1);
    expect(parsed.max_parallelism).toBe(1);
    expect(parsed.topology).toBe('serial');
  });

  test('accepts_epic_ref_alternative', async () => {
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote')) return 'https://github.com/org/repo.git\n';
      if (cmd.includes('gh issue view 100')) {
        return JSON.stringify({
          body: '## Sub-Issues\n- #5 a\n- #6 b\n',
          title: 'Epic',
        });
      }
      if (cmd.includes('gh issue view 5')) {
        return JSON.stringify({ body: '## Dependencies\nNone\n', title: '5' });
      }
      if (cmd.includes('gh issue view 6')) {
        return JSON.stringify({ body: '## Dependencies\nNone\n', title: '6' });
      }
      return '';
    };
    const result = await handler.execute({ epic_ref: '#100' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.wave_count).toBe(1);
    expect(parsed.topology).toBe('parallel');
  });

  test('schema_validation — rejects both issue_refs and epic_ref', async () => {
    const result = await handler.execute({ issue_refs: ['#1'], epic_ref: '#2' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });

  test('schema_validation — rejects neither issue_refs nor epic_ref', async () => {
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });

  test('fetched_count — all success', async () => {
    mockIssues({
      '5': '## Dependencies\nNone\n',
      '6': '## Dependencies\nNone\n',
    });
    const result = await handler.execute({ issue_refs: ['#5', '#6'] });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.fetched_count).toBe(2);
    expect(parsed.issue_count).toBe(2);
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
    expect(parsed.issue_count).toBe(3);
    expect(parsed.warnings).toBeDefined();
    expect(parsed.warnings.length).toBe(1);
    expect(parsed.warnings[0]).toContain('org/repo#6');
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
