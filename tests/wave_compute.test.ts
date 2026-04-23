import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';

let execMockFn: (cmd: string) => string = () => '';
const mockExecSync = mock((cmd: string, _opts?: unknown) => execMockFn(cmd));
mock.module('child_process', () => ({ execSync: mockExecSync }));

const { default: handler } = await import('../handlers/wave_compute.ts');

function resetMocks() {
  execMockFn = () => '';
  mockExecSync.mockClear();
}

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

/**
 * Build a mock that serves an epic body plus a set of sub-issue bodies.
 * The epic body should list sub-issues; each sub-issue's body lists its
 * own Dependencies section.
 */
function mockGraph(
  epicBody: string,
  subIssues: Record<string, { body: string; title?: string }>,
) {
  execMockFn = (cmd: string) => {
    if (cmd.startsWith('git remote')) return 'https://github.com/org/repo.git\n';
    if (cmd.includes('gh issue view')) {
      // Detect which issue is being asked for.
      const m = /gh issue view (\S+)/.exec(cmd);
      if (!m) return JSON.stringify({ body: '', title: '' });
      const n = m[1];
      if (n === '100') {
        return JSON.stringify({ body: epicBody, title: 'Epic 100' });
      }
      // Match #N within sub issues OR a full org/repo#N (if cmd contains --repo).
      for (const [ref, data] of Object.entries(subIssues)) {
        // Extract number from ref (org/repo#N or #N).
        const refM = /#(\d+)$/.exec(ref);
        if (refM && refM[1] === n) {
          return JSON.stringify({ body: data.body, title: data.title ?? `Issue ${n}` });
        }
      }
      return JSON.stringify({ body: '', title: `Issue ${n}` });
    }
    return '';
  };
}

describe('wave_compute handler', () => {
  beforeEach(resetMocks);
  afterEach(resetMocks);

  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('wave_compute');
    expect(typeof handler.execute).toBe('function');
  });

  test('linear_chain_produces_serial_topology', async () => {
    const epicBody = `## Sub-Issues

- #5 first
- #6 second
- #7 third
`;
    const subs: Record<string, { body: string; title?: string }> = {
      'org/repo#5': { body: '## Dependencies\nNone\n', title: 'first' },
      'org/repo#6': { body: '## Dependencies\n- #5\n', title: 'second' },
      'org/repo#7': { body: '## Dependencies\n- #6\n', title: 'third' },
    };
    mockGraph(epicBody, subs);
    const result = await handler.execute({ epic_ref: '#100' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.topology).toBe('serial');
    expect(parsed.reason).toBe('dependency chain forces ordering');
    expect(parsed.waves.length).toBe(3);
    expect(parsed.waves[0].issues.length).toBe(1);
    expect(parsed.waves[2].issues[0].ref).toBe('org/repo#7');
  });

  test('independent_issues_produce_single_parallel_wave', async () => {
    const epicBody = `## Sub-Issues

- #5 a
- #6 b
- #7 c
`;
    const subs: Record<string, { body: string; title?: string }> = {
      'org/repo#5': { body: '## Dependencies\nNone\n' },
      'org/repo#6': { body: '## Dependencies\nNone\n' },
      'org/repo#7': { body: '## Dependencies\nNone\n' },
    };
    mockGraph(epicBody, subs);
    const result = await handler.execute({ epic_ref: '#100' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.topology).toBe('parallel');
    expect(parsed.reason).toBe('no dependencies');
    expect(parsed.waves.length).toBe(1);
    expect(parsed.waves[0].issues.length).toBe(3);
  });

  test('diamond_dependency — 2 waves (A,B parallel; C after)', async () => {
    const epicBody = `## Sub-Issues

- #5 A
- #6 B
- #7 C
`;
    const subs: Record<string, { body: string; title?: string }> = {
      'org/repo#5': { body: '## Dependencies\nNone\n' },
      'org/repo#6': { body: '## Dependencies\nNone\n' },
      'org/repo#7': { body: '## Dependencies\n- #5\n- #6\n' },
    };
    mockGraph(epicBody, subs);
    const result = await handler.execute({ epic_ref: '#100' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.waves.length).toBe(2);
    expect(parsed.waves[0].issues.length).toBe(2);
    expect(parsed.waves[1].issues.length).toBe(1);
    expect(parsed.topology).toBe('mixed');
  });

  test('circular_dependency_returns_error', async () => {
    const epicBody = `## Sub-Issues

- #5 A
- #6 B
`;
    const subs: Record<string, { body: string; title?: string }> = {
      'org/repo#5': { body: '## Dependencies\n- #6\n' },
      'org/repo#6': { body: '## Dependencies\n- #5\n' },
    };
    mockGraph(epicBody, subs);
    const result = await handler.execute({ epic_ref: '#100' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('circular');
  });

  test('schema_validation — rejects missing epic_ref', async () => {
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });

  test('fetched_count — all success', async () => {
    const epicBody = `## Sub-Issues

- #5 first
- #6 second
`;
    const subs: Record<string, { body: string; title?: string }> = {
      'org/repo#5': { body: '## Dependencies\nNone\n', title: 'first' },
      'org/repo#6': { body: '## Dependencies\nNone\n', title: 'second' },
    };
    mockGraph(epicBody, subs);
    const result = await handler.execute({ epic_ref: '#100' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.fetched_count).toBe(2);
    expect(parsed.total_issues).toBe(2);
    expect(parsed.warnings).toBeUndefined();
  });

  test('partial_failure — some sub-issue fetches fail', async () => {
    const epicBody = `## Sub-Issues

- #5 first
- #6 second
- #7 third
`;
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote')) return 'https://github.com/org/repo.git\n';
      if (cmd.includes('gh issue view 100')) {
        return JSON.stringify({ body: epicBody, title: 'Epic 100' });
      }
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
    const result = await handler.execute({ epic_ref: '#100' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.fetched_count).toBe(2);
    expect(parsed.total_issues).toBe(2);
    expect(parsed.warnings).toBeDefined();
    expect(parsed.warnings.length).toBe(1);
    expect(parsed.warnings[0]).toContain('org/repo#6');
  });

  test('total_failure — all sub-issue fetches fail', async () => {
    const epicBody = `## Sub-Issues

- #5 first
- #6 second
`;
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote')) return 'https://github.com/org/repo.git\n';
      if (cmd.includes('gh issue view 100')) {
        return JSON.stringify({ body: epicBody, title: 'Epic 100' });
      }
      if (cmd.includes('gh issue view')) {
        throw new Error('fetch failed');
      }
      return '';
    };
    const result = await handler.execute({ epic_ref: '#100' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.fetched_count).toBe(0);
    expect(parsed.issue_count).toBe(2);
    expect(parsed.error).toContain('all 2 spec fetches failed');
  });

  test('story_self_fallback — no sub-issues, valid spec → single-wave plan', async () => {
    // Story body has all three required sections but no ## Sub-Issues section.
    const storyBody = `## Changes

- Do the thing.

## Tests

- Verify the thing.

## Acceptance Criteria

- [ ] Thing done.
`;
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote')) return 'https://github.com/org/repo.git\n';
      if (cmd.includes('gh issue view 398')) {
        return JSON.stringify({ body: storyBody, title: 'Story 398' });
      }
      return '';
    };
    const result = await handler.execute({ epic_ref: '#398' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.waves.length).toBe(1);
    expect(parsed.waves[0].issues.length).toBe(1);
    expect(parsed.waves[0].issues[0].ref).toBe('org/repo#398');
    expect(parsed.topology).toBe('serial');
    expect(parsed.reason).toBe('single issue (trivial)');
    expect(parsed.fallback_reason).toBe('story-self');
    expect(parsed.total_issues).toBe(1);
    expect(parsed.fetched_count).toBe(1);
  });

  test('story_self_fallback — no sub-issues, invalid spec → errors loudly', async () => {
    // Story body missing ## Acceptance Criteria → must NOT silently return empty.
    const storyBody = `## Changes

- Do the thing.

## Tests

- Verify the thing.
`;
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote')) return 'https://github.com/org/repo.git\n';
      if (cmd.includes('gh issue view 398')) {
        return JSON.stringify({ body: storyBody, title: 'Story 398' });
      }
      return '';
    };
    const result = await handler.execute({ epic_ref: '#398' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    // Must NOT be the old silent-empty shape.
    expect(parsed.reason).not.toBe('no issues');
    expect(parsed.waves).toBeUndefined();
    // Error must name what's missing.
    expect(parsed.error).toContain('acceptance_criteria');
    expect(parsed.missing_sections).toEqual(['acceptance_criteria']);
  });

  // Regression: epic with sub-issues continues to work as before.
  // The existing `linear_chain_produces_serial_topology`,
  // `independent_issues_produce_single_parallel_wave`, `diamond_dependency`,
  // and `fetched_count — all success` tests exercise the multi-sub-issue path.
  // This test double-checks that the fallback logic does NOT fire when sub-issues exist.
  test('epic_with_subissues_regression — fallback does not fire', async () => {
    const epicBody = `## Sub-Issues

- #5 first
- #6 second
`;
    const subs: Record<string, { body: string; title?: string }> = {
      'org/repo#5': { body: '## Dependencies\nNone\n', title: 'first' },
      'org/repo#6': { body: '## Dependencies\nNone\n', title: 'second' },
    };
    mockGraph(epicBody, subs);
    const result = await handler.execute({ epic_ref: '#100' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.fallback_reason).toBeUndefined();
    expect(parsed.total_issues).toBe(2);
    expect(parsed.waves[0].issues.length).toBe(2);
  });

  test('epic_fetch_failure_surfaces_loudly', async () => {
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
