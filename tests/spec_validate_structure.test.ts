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

  test('implementation_steps_satisfies_changes_alias', async () => {
    mockBody(
      '## Implementation Steps\n1. do stuff\n## Tests\nt\n## Acceptance Criteria\n- [ ] ok\n',
    );
    const result = await handler.execute({ issue_ref: '#1' });
    const parsed = parseResult(result);
    expect(parsed.valid).toBe(true);
    expect(parsed.has_changes).toBe(true);
    expect(parsed.missing_sections).toEqual([]);
  });

  test('test_procedures_satisfies_tests_alias', async () => {
    mockBody(
      '## Changes\nc\n## Test Procedures\n- unit tests\n## Acceptance Criteria\n- [ ] ok\n',
    );
    const result = await handler.execute({ issue_ref: '#1' });
    const parsed = parseResult(result);
    expect(parsed.valid).toBe(true);
    expect(parsed.has_tests).toBe(true);
  });

  test('both_aliases_together_valid', async () => {
    mockBody(
      '## Implementation Steps\n1.\n## Test Procedures\n- ok\n## Acceptance Criteria\n- [ ] ok\n',
    );
    const result = await handler.execute({ issue_ref: '#1' });
    const parsed = parseResult(result);
    expect(parsed.valid).toBe(true);
    expect(parsed.has_changes).toBe(true);
    expect(parsed.has_tests).toBe(true);
  });

  test('accepted_headings_surfaced_when_missing', async () => {
    mockBody('## Summary\nnothing relevant\n');
    const result = await handler.execute({ issue_ref: '#1' });
    const parsed = parseResult(result);
    expect(parsed.valid).toBe(false);
    expect(parsed.accepted_headings).toBeDefined();
    expect(parsed.accepted_headings.changes).toEqual(
      expect.arrayContaining(['## Changes', '## Implementation Steps']),
    );
    expect(parsed.accepted_headings.tests).toEqual(
      expect.arrayContaining(['## Tests', '## Test Procedures']),
    );
  });

  test('accepted_headings_absent_when_valid', async () => {
    mockBody(
      '## Changes\nc\n## Tests\nt\n## Acceptance Criteria\n- [ ] ok\n',
    );
    const result = await handler.execute({ issue_ref: '#1' });
    const parsed = parseResult(result);
    expect(parsed.valid).toBe(true);
    expect(parsed.accepted_headings).toBeUndefined();
  });

  // ---- #208: bold-label dependencies fallback (parity with spec_dependencies) ----

  test('has_dependencies_true — explicit ## Dependencies H2 (regression)', async () => {
    mockBody(
      '## Changes\nc\n## Tests\nt\n## Acceptance Criteria\n- [ ] ok\n## Dependencies\n- #5\n',
    );
    const result = await handler.execute({ issue_ref: '#1' });
    const parsed = parseResult(result);
    expect(parsed.has_dependencies).toBe(true);
  });

  test('has_dependencies_true — bold-label fallback inside ## Metadata', async () => {
    // Mirrors what /devspec upshift produces for stories: deps live as a
    // **Dependencies:** label under ## Metadata, not in a dedicated H2.
    mockBody(
      '## Changes\nc\n## Tests\nt\n## Acceptance Criteria\n- [ ] ok\n' +
      '## Metadata\n\n**Priority:** medium\n**Dependencies:** #86, #87\n',
    );
    const result = await handler.execute({ issue_ref: '#1' });
    const parsed = parseResult(result);
    expect(parsed.has_dependencies).toBe(true);
  });

  test('has_dependencies_true — bold-label fallback in arbitrary section', async () => {
    mockBody(
      '## Changes\nc\n## Tests\nt\n## Acceptance Criteria\n- [ ] ok\n' +
      '## Notes\nSome prose.\n\n**Dependencies:** Wave-Engineering/foo#42\n',
    );
    const result = await handler.execute({ issue_ref: '#1' });
    const parsed = parseResult(result);
    expect(parsed.has_dependencies).toBe(true);
  });

  test('has_dependencies_false — neither ## Dependencies nor bold label present', async () => {
    mockBody(
      '## Changes\nc\n## Tests\nt\n## Acceptance Criteria\n- [ ] ok\n## Metadata\n**Priority:** low\n',
    );
    const result = await handler.execute({ issue_ref: '#1' });
    const parsed = parseResult(result);
    expect(parsed.has_dependencies).toBe(false);
  });

  test('explicit ## Dependencies still wins when both forms are present', async () => {
    mockBody(
      '## Changes\nc\n## Tests\nt\n## Acceptance Criteria\n- [ ] ok\n' +
      '## Dependencies\n- #5\n## Metadata\n**Dependencies:** #6\n',
    );
    const result = await handler.execute({ issue_ref: '#1' });
    const parsed = parseResult(result);
    expect(parsed.has_dependencies).toBe(true);
  });

  test('changes/tests fallback NOT relaxed — bold-label scope is dependencies-only', async () => {
    // **Tests:** inside another section must NOT count as has_tests.
    // Implementation/test sections remain strict; only the dependencies
    // metadata field gets the fallback.
    mockBody(
      '## Changes\nc\n## Acceptance Criteria\n- [ ] ok\n' +
      '## Metadata\n**Tests:** see other repo\n**Dependencies:** #5\n',
    );
    const result = await handler.execute({ issue_ref: '#1' });
    const parsed = parseResult(result);
    expect(parsed.has_tests).toBe(false);
    expect(parsed.has_dependencies).toBe(true);
    expect(parsed.valid).toBe(false);
    expect(parsed.missing_sections).toContain('tests');
  });
});
