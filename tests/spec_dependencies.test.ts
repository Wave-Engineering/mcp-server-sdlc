import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';

let execMockFn: (cmd: string) => string = () => '';
const mockExecSync = mock((cmd: string, _opts?: unknown) => execMockFn(cmd));
mock.module('child_process', () => ({ execSync: mockExecSync }));

const { default: handler } = await import('../handlers/spec_dependencies.ts');

function resetMocks() {
  execMockFn = () => '';
  mockExecSync.mockClear();
}

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

function mockBody(body: string, originUrl = 'https://github.com/myorg/myrepo.git') {
  execMockFn = (cmd: string) => {
    if (cmd.startsWith('git remote')) return originUrl + '\n';
    if (cmd.includes('gh issue view')) return JSON.stringify({ body });
    return '';
  };
}

describe('spec_dependencies handler', () => {
  beforeEach(resetMocks);
  afterEach(resetMocks);

  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('spec_dependencies');
    expect(typeof handler.execute).toBe('function');
  });

  test('parses_same_repo_refs — #N normalized to current repo slug', async () => {
    mockBody(`## Dependencies

- #284
- #285
`);
    const result = await handler.execute({ issue_ref: '#1' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.dependencies.map((d: { ref: string }) => d.ref)).toEqual([
      'myorg/myrepo#284',
      'myorg/myrepo#285',
    ]);
  });

  test('parses_cross_repo_refs — org/repo#N preserved', async () => {
    mockBody(`## Dependencies

- Wave-Engineering/mcp-server-sdlc#26
- acme/widgets#42
`);
    const result = await handler.execute({ issue_ref: '#1' });
    const parsed = parseResult(result);
    expect(parsed.dependencies.map((d: { ref: string }) => d.ref)).toEqual([
      'Wave-Engineering/mcp-server-sdlc#26',
      'acme/widgets#42',
    ]);
  });

  test('parses_full_urls — github URL normalized to org/repo#N', async () => {
    mockBody(`## Dependencies

- https://github.com/Wave-Engineering/claudecode-workflow/issues/289
`);
    const result = await handler.execute({ issue_ref: '#1' });
    const parsed = parseResult(result);
    expect(parsed.dependencies[0].ref).toBe('Wave-Engineering/claudecode-workflow#289');
  });

  test('parses_gitlab_urls', async () => {
    mockBody(`## Dependencies

- https://gitlab.com/mygroup/myproject/-/issues/12
`);
    const result = await handler.execute({ issue_ref: '#1' });
    const parsed = parseResult(result);
    expect(parsed.dependencies[0].ref).toBe('mygroup/myproject#12');
  });

  test('none_keyword — returns empty list', async () => {
    mockBody(`## Dependencies

None
`);
    const result = await handler.execute({ issue_ref: '#1' });
    const parsed = parseResult(result);
    expect(parsed.dependencies).toEqual([]);
    expect(parsed.count).toBe(0);
  });

  test('no_dependencies_section — returns empty list', async () => {
    mockBody('## Summary\nstuff\n');
    const result = await handler.execute({ issue_ref: '#1' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.count).toBe(0);
  });

  test('deduplicates_refs', async () => {
    mockBody(`## Dependencies

- #5
- #5
- myorg/myrepo#5
`);
    const result = await handler.execute({ issue_ref: '#1' });
    const parsed = parseResult(result);
    expect(parsed.count).toBe(1);
  });

  test('schema_validation — rejects missing issue_ref', async () => {
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });

  test('bold_label_fallback — **Dependencies:** inside ## Metadata', async () => {
    mockBody(`## Summary

The thing.

## Metadata

- **Wave:** 2
- **Phase:** 1
- **Parent Epic:** #85
- **Dependencies:** Stories 1.1 (#86), 1.2 (#87)
`);
    const result = await handler.execute({ issue_ref: '#99' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.source).toBe('bold_label_fallback');
    expect(parsed.dependencies.map((d: { ref: string }) => d.ref)).toEqual([
      'myorg/myrepo#86',
      'myorg/myrepo#87',
    ]);
  });

  test('bold_label_fallback — cross-repo refs in bold label', async () => {
    mockBody(`## Metadata

- **Dependencies:** Wave-Engineering/mcp-server-sdlc#181, #92
`);
    const result = await handler.execute({ issue_ref: '#99' });
    const parsed = parseResult(result);
    expect(parsed.source).toBe('bold_label_fallback');
    expect(parsed.dependencies.map((d: { ref: string }) => d.ref)).toEqual([
      'Wave-Engineering/mcp-server-sdlc#181',
      'myorg/myrepo#92',
    ]);
  });

  test('dependencies_section_preferred_over_bold_label', async () => {
    mockBody(`## Dependencies

- #200

## Metadata

- **Dependencies:** #999
`);
    const result = await handler.execute({ issue_ref: '#1' });
    const parsed = parseResult(result);
    expect(parsed.source).toBe('dependencies_section');
    expect(parsed.dependencies.map((d: { ref: string }) => d.ref)).toEqual([
      'myorg/myrepo#200',
    ]);
  });

  test('source_is_none_when_no_deps_present', async () => {
    mockBody('## Summary\nfoo\n');
    const result = await handler.execute({ issue_ref: '#1' });
    const parsed = parseResult(result);
    expect(parsed.source).toBe('none');
    expect(parsed.count).toBe(0);
  });

  test('source_is_dependencies_section_when_explicit', async () => {
    mockBody(`## Dependencies

- #5
`);
    const result = await handler.execute({ issue_ref: '#1' });
    const parsed = parseResult(result);
    expect(parsed.source).toBe('dependencies_section');
  });

  test('bold_label_stops_at_next_bold_label', async () => {
    mockBody(`## Metadata

- **Dependencies:** #50
- **Reviewer:** @alice #999
`);
    const result = await handler.execute({ issue_ref: '#1' });
    const parsed = parseResult(result);
    // Only #50 should be picked up; #999 is after **Reviewer:**
    expect(parsed.dependencies.map((d: { ref: string }) => d.ref)).toEqual([
      'myorg/myrepo#50',
    ]);
  });

  test('bold_label_with_prose_but_no_refs_reverts_source_to_none', async () => {
    mockBody(`## Metadata

- **Dependencies:** See planning doc TBD, awaiting spec
`);
    const result = await handler.execute({ issue_ref: '#1' });
    const parsed = parseResult(result);
    expect(parsed.count).toBe(0);
    // Guard at handler: fallback yielded text but no refs → source reverts
    // to 'none' so callers aren't misled about where non-refs came from.
    expect(parsed.source).toBe('none');
  });

  test('empty_bold_label_yields_no_deps', async () => {
    mockBody(`## Metadata

- **Dependencies:**
- **Wave:** 1
`);
    const result = await handler.execute({ issue_ref: '#1' });
    const parsed = parseResult(result);
    expect(parsed.count).toBe(0);
    // With no content in the label, source stays 'none'.
    expect(parsed.source).toBe('none');
  });
});
