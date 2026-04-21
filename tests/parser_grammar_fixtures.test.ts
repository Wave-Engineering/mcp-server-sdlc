/**
 * Fixture-based regression tests for the parser grammar contract.
 *
 * Each fixture under `tests/fixtures/parser-grammar/` is a verbatim issue
 * body produced by a real skill or template (`/devspec upshift`, `/issue`,
 * etc.) at the point this contract was established. If a skill later
 * changes its output shape, these tests fail loudly — exactly the drift
 * signal we want.
 *
 * When adding a new skill or template, add a new fixture here with a
 * dedicated test asserting clean extraction. See docs/issue-body-grammar.md.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

let execMockFn: (cmd: string) => string = () => '';
const mockExecSync = mock((cmd: string, _opts?: unknown) => execMockFn(cmd));
mock.module('child_process', () => ({ execSync: mockExecSync }));

const { default: validateHandler } = await import('../handlers/spec_validate_structure.ts');
const { default: epicHandler } = await import('../handlers/epic_sub_issues.ts');
const { default: depsHandler } = await import('../handlers/spec_dependencies.ts');

function resetMocks() {
  execMockFn = () => '';
  mockExecSync.mockClear();
}

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

function fixture(name: string): string {
  return readFileSync(join(import.meta.dir, 'fixtures/parser-grammar', name), 'utf8');
}

function mockBody(body: string, origin = 'https://github.com/blueshift/cue.git') {
  execMockFn = (cmd: string) => {
    if (cmd.startsWith('git remote')) return origin + '\n';
    if (cmd.includes('gh issue view')) return JSON.stringify({ body });
    return '';
  };
}

describe('parser grammar fixtures — /devspec upshift', () => {
  beforeEach(resetMocks);
  afterEach(resetMocks);

  test('epic-simple-stories — ## Stories bullets parsed as sub-issues', async () => {
    mockBody(fixture('epic-simple-stories.md'));
    const result = await epicHandler.execute({ epic_ref: '#85' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.count).toBe(5);
    expect(parsed.sub_issues[0].ref).toBe('blueshift/cue#86');
  });

  test('epic-wave-grouped — ## Waves with ### Wave N + bullets parses all refs', async () => {
    mockBody(fixture('epic-wave-grouped.md'));
    const result = await epicHandler.execute({ epic_ref: '#85' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.count).toBe(7);
    expect(parsed.sub_issues.map((s: { ref: string }) => s.ref)).toEqual([
      'blueshift/cue#86',
      'blueshift/cue#87',
      'blueshift/cue#89',
      'blueshift/cue#90',
      'blueshift/cue#92',
      'blueshift/cue#93',
      'blueshift/cue#94',
    ]);
  });

  test('story-upshift-with-deps — validates as valid (aliases accepted)', async () => {
    mockBody(fixture('story-upshift-with-deps.md'));
    const result = await validateHandler.execute({ issue_ref: '#89' });
    const parsed = parseResult(result);
    expect(parsed.valid).toBe(true);
    expect(parsed.has_changes).toBe(true);
    expect(parsed.has_tests).toBe(true);
    expect(parsed.has_acceptance_criteria).toBe(true);
    expect(parsed.missing_sections).toEqual([]);
  });

  test('story-upshift-with-deps — bold-label deps extracted from ## Metadata', async () => {
    mockBody(fixture('story-upshift-with-deps.md'));
    const result = await depsHandler.execute({ issue_ref: '#89' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.source).toBe('bold_label_fallback');
    expect(parsed.dependencies.map((d: { ref: string }) => d.ref)).toEqual([
      'blueshift/cue#86',
      'blueshift/cue#87',
    ]);
  });
});

describe('parser grammar fixtures — /issue feature', () => {
  beforeEach(resetMocks);
  afterEach(resetMocks);

  test('story-issue-feature — validates as valid', async () => {
    mockBody(fixture('story-issue-feature.md'));
    const result = await validateHandler.execute({ issue_ref: '#10' });
    const parsed = parseResult(result);
    expect(parsed.valid).toBe(true);
  });

  test('story-issue-feature — deps from explicit ## Dependencies section', async () => {
    mockBody(fixture('story-issue-feature.md'));
    const result = await depsHandler.execute({ issue_ref: '#10' });
    const parsed = parseResult(result);
    expect(parsed.source).toBe('dependencies_section');
    // parseDependenciesSection iterates URLs → cross-repo → short refs, so
    // order is by form, not input position. Assert membership, not order.
    expect(parsed.count).toBe(2);
    expect(parsed.dependencies.map((d: { ref: string }) => d.ref)).toEqual(
      expect.arrayContaining(['blueshift/cue#86', 'Wave-Engineering/mcp-server-sdlc#181']),
    );
  });
});
