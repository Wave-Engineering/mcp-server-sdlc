import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';

let execMockFn: (cmd: string) => string = () => '';
const mockExecSync = mock((cmd: string, _opts?: unknown) => execMockFn(cmd));
mock.module('child_process', () => ({ execSync: mockExecSync }));

const { default: handler } = await import('../handlers/spec_get.ts');

function resetMocks() {
  execMockFn = () => '';
  mockExecSync.mockClear();
}

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

const FULL_BODY = `## Summary

This is the summary section.

## Changes

- bullet one
- bullet two

## Tests

- \`test_a\` does a thing
- \`test_b\` does another

## Acceptance Criteria

- [ ] criterion one
- [ ] criterion two

## Dependencies

- depends on #5
`;

describe('spec_get handler', () => {
  beforeEach(resetMocks);
  afterEach(resetMocks);

  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('spec_get');
    expect(typeof handler.execute).toBe('function');
  });

  test('parses_standard_sections — Summary/Changes/Tests/Acceptance Criteria/Dependencies', async () => {
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote')) return 'https://github.com/org/repo.git\n';
      if (cmd.includes('gh issue view 42')) {
        return JSON.stringify({
          number: 42,
          title: 'Implement foo',
          body: FULL_BODY,
          state: 'open',
          labels: [{ name: 'type::story' }, { name: 'priority::high' }],
        });
      }
      return '';
    };
    const result = await handler.execute({ issue_ref: '#42' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.number).toBe(42);
    expect(parsed.title).toBe('Implement foo');
    expect(parsed.state).toBe('OPEN');
    expect(parsed.labels).toEqual(['type::story', 'priority::high']);
    expect(parsed.sections.summary).toContain('summary section');
    expect(parsed.sections.changes).toContain('bullet one');
    expect(parsed.sections.tests).toContain('test_a');
    expect(parsed.sections.acceptance_criteria).toContain('criterion one');
    expect(parsed.sections.dependencies).toContain('#5');
    expect(parsed.section_order).toEqual([
      'summary',
      'changes',
      'tests',
      'acceptance_criteria',
      'dependencies',
    ]);
  });

  test('handles_cross_repo_ref — org/repo#N format uses --repo flag', async () => {
    let seenCmd = '';
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote')) return 'https://github.com/other/thing.git\n';
      if (cmd.includes('gh issue view')) {
        seenCmd = cmd;
        return JSON.stringify({
          number: 7,
          title: 'Cross-repo',
          body: '## Summary\nhello',
          state: 'open',
          labels: [],
        });
      }
      return '';
    };
    const result = await handler.execute({ issue_ref: 'acme/widgets#7' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(seenCmd).toContain('--repo acme/widgets');
    expect(seenCmd).toContain(' 7 ');
  });

  test('handles_missing_sections — body without sections', async () => {
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote')) return 'https://github.com/org/repo.git\n';
      if (cmd.includes('gh issue view')) {
        return JSON.stringify({
          number: 1,
          title: 'Bare',
          body: 'just prose, no headings',
          state: 'open',
          labels: [],
        });
      }
      return '';
    };
    const result = await handler.execute({ issue_ref: '#1' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.sections).toEqual({});
    expect(parsed.section_order).toEqual([]);
  });

  test('normalizes_section_headings — "Acceptance Criteria" -> acceptance_criteria', async () => {
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote')) return 'https://github.com/org/repo.git\n';
      if (cmd.includes('gh issue view')) {
        return JSON.stringify({
          number: 1,
          title: 'Norm',
          body: '## Acceptance Criteria\n- x\n## Test Plan\n- y\n',
          state: 'open',
          labels: [],
        });
      }
      return '';
    };
    const result = await handler.execute({ issue_ref: '#1' });
    const parsed = parseResult(result);
    expect(parsed.sections.acceptance_criteria).toBeDefined();
    expect(parsed.sections.test_plan).toBeDefined();
  });

  test('handles_nonexistent_issue — gh error returns structured error', async () => {
    execMockFn = (cmd: string) => {
      if (cmd.startsWith('git remote')) return 'https://github.com/org/repo.git\n';
      throw new Error('gh: issue #9999 not found');
    };
    const result = await handler.execute({ issue_ref: '#9999' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('not found');
  });

  test('handles_malformed_issue_ref', async () => {
    const result = await handler.execute({ issue_ref: 'not-a-ref' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('could not parse');
  });

  test('schema_validation — rejects missing issue_ref', async () => {
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });

  test('schema_validation — rejects empty issue_ref', async () => {
    const result = await handler.execute({ issue_ref: '' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });
});
