import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';

let execMockFn: (cmd: string) => string = () => '';
const mockExecSync = mock((cmd: string, _opts?: unknown) => execMockFn(cmd));
mock.module('child_process', () => ({ execSync: mockExecSync }));

const { default: handler } = await import('../handlers/spec_validate_structure.ts');

function resetMocks() {
  execMockFn = () => '';
  mockExecSync.mockClear();
}

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

function mockBody(body: string) {
  execMockFn = (cmd: string) => {
    if (cmd.startsWith('git remote')) return 'https://github.com/org/repo.git\n';
    if (cmd.includes('gh issue view')) {
      return JSON.stringify({ body });
    }
    return '';
  };
}

describe('spec_validate_structure handler', () => {
  beforeEach(resetMocks);
  afterEach(resetMocks);

  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('spec_validate_structure');
    expect(typeof handler.execute).toBe('function');
  });

  test('all_sections_present — returns valid=true, missing empty', async () => {
    mockBody(
      '## Changes\nstuff\n## Tests\nmore\n## Acceptance Criteria\n- [ ] ok\n## Dependencies\n#1\n',
    );
    const result = await handler.execute({ issue_ref: '#42' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.valid).toBe(true);
    expect(parsed.has_changes).toBe(true);
    expect(parsed.has_tests).toBe(true);
    expect(parsed.has_acceptance_criteria).toBe(true);
    expect(parsed.has_dependencies).toBe(true);
    expect(parsed.missing_sections).toEqual([]);
  });

  test('missing_changes — reports changes in missing_sections', async () => {
    mockBody('## Tests\nt\n## Acceptance Criteria\n- [ ] x\n');
    const result = await handler.execute({ issue_ref: '#1' });
    const parsed = parseResult(result);
    expect(parsed.valid).toBe(false);
    expect(parsed.has_changes).toBe(false);
    expect(parsed.missing_sections).toContain('changes');
  });

  test('missing_acceptance_criteria — reports AC in missing_sections', async () => {
    mockBody('## Changes\nc\n## Tests\nt\n');
    const result = await handler.execute({ issue_ref: '#1' });
    const parsed = parseResult(result);
    expect(parsed.valid).toBe(false);
    expect(parsed.has_acceptance_criteria).toBe(false);
    expect(parsed.missing_sections).toContain('acceptance_criteria');
  });

  test('dependencies_optional — missing dependencies is OK', async () => {
    mockBody('## Changes\nc\n## Tests\nt\n## Acceptance Criteria\n- [ ] x\n');
    const result = await handler.execute({ issue_ref: '#1' });
    const parsed = parseResult(result);
    expect(parsed.valid).toBe(true);
    expect(parsed.has_dependencies).toBe(false);
    expect(parsed.missing_sections).not.toContain('dependencies');
  });

  test('empty_section_counts_as_missing', async () => {
    mockBody('## Changes\n\n## Tests\nt\n## Acceptance Criteria\n- [ ] x\n');
    const result = await handler.execute({ issue_ref: '#1' });
    const parsed = parseResult(result);
    expect(parsed.has_changes).toBe(false);
    expect(parsed.missing_sections).toContain('changes');
  });

  test('schema_validation — rejects missing issue_ref', async () => {
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });

  test('malformed_issue_ref_returns_error', async () => {
    const result = await handler.execute({ issue_ref: 'garbage' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });
});
