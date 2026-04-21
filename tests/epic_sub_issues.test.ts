import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';

let execMockFn: (cmd: string) => string = () => '';
const mockExecSync = mock((cmd: string, _opts?: unknown) => execMockFn(cmd));
mock.module('child_process', () => ({ execSync: mockExecSync }));

const { default: handler } = await import('../handlers/epic_sub_issues.ts');

function resetMocks() {
  execMockFn = () => '';
  mockExecSync.mockClear();
}

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

function mockBody(body: string) {
  execMockFn = (cmd: string) => {
    if (cmd.startsWith('git remote')) return 'https://github.com/myorg/myrepo.git\n';
    if (cmd.includes('gh issue view')) return JSON.stringify({ body });
    return '';
  };
}

describe('epic_sub_issues handler', () => {
  beforeEach(resetMocks);
  afterEach(resetMocks);

  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('epic_sub_issues');
    expect(typeof handler.execute).toBe('function');
  });

  test('parses_table_format — order/issue/title columns', async () => {
    mockBody(`## Sub-Issues

| Order | Issue | Title | Deps |
|-------|-------|-------|------|
| 1 | #5 | wave_init | none |
| 2 | #6 | wave_preflight | none |
| 3 | Wave-Engineering/other#42 | cross repo | #5 |
`);
    const result = await handler.execute({ epic_ref: '#100' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.count).toBe(3);
    expect(parsed.sub_issues[0]).toEqual({
      ref: 'myorg/myrepo#5',
      title: 'wave_init',
      order: 1,
    });
    expect(parsed.sub_issues[2].ref).toBe('Wave-Engineering/other#42');
  });

  test('parses_checklist_format — - [ ] #N Title', async () => {
    mockBody(`## Sub-Issues

- [ ] #5 wave_init
- [x] #6 wave_preflight
- [ ] Wave-Engineering/other#42 cross-repo task
`);
    const result = await handler.execute({ epic_ref: '#100' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.count).toBe(3);
    expect(parsed.sub_issues[0].ref).toBe('myorg/myrepo#5');
    expect(parsed.sub_issues[0].title).toBe('wave_init');
  });

  test('parses_bullet_format — - #N Title', async () => {
    mockBody(`## Sub-Issues

- #5 wave_init
- #6 wave_preflight
`);
    const result = await handler.execute({ epic_ref: '#100' });
    const parsed = parseResult(result);
    expect(parsed.count).toBe(2);
    expect(parsed.sub_issues[1].ref).toBe('myorg/myrepo#6');
    expect(parsed.sub_issues[1].order).toBe(2);
  });

  test('preserves_order_from_table', async () => {
    mockBody(`## Sub-Issues

| Order | Issue |
|-------|-------|
| 3 | #5 |
| 1 | #6 |
| 2 | #7 |
`);
    const result = await handler.execute({ epic_ref: '#100' });
    const parsed = parseResult(result);
    expect(parsed.sub_issues.map((s: { order?: number }) => s.order)).toEqual([3, 1, 2]);
  });

  test('no_sub_issues_section_returns_empty', async () => {
    mockBody('## Summary\nNo sub-issues here.\n');
    const result = await handler.execute({ epic_ref: '#100' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.count).toBe(0);
  });

  test('schema_validation — rejects missing epic_ref', async () => {
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });

  test('parses_wave_grouped_epic — ## Waves with ### Wave N + bullets', async () => {
    mockBody(`## Waves

### Wave 1 — Foundation (master: #88)

- #86 — Story 1.1: Pipeline config schema
- #87 — Story 1.2: Pipeline config loader

### Wave 2 — Services (master: #91)

- #89 — Story 2.1: Pipeline Service
- #90 — Story 2.2: Pipeline Executor
`);
    const result = await handler.execute({ epic_ref: '#100' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.count).toBe(4);
    expect(parsed.sub_issues.map((s: { ref: string }) => s.ref)).toEqual([
      'myorg/myrepo#86',
      'myorg/myrepo#87',
      'myorg/myrepo#89',
      'myorg/myrepo#90',
    ]);
    expect(parsed.sub_issues[0].title).toBe('Story 1.1: Pipeline config schema');
  });

  test('parses_stories_section_alias', async () => {
    mockBody(`## Stories

- #10 — Story A
- #11 — Story B
`);
    const result = await handler.execute({ epic_ref: '#100' });
    const parsed = parseResult(result);
    expect(parsed.count).toBe(2);
    expect(parsed.sub_issues[0].ref).toBe('myorg/myrepo#10');
  });

  test('parses_phases_alias', async () => {
    mockBody(`## Phases

- #20 — Phase 1 master
- #21 — Phase 2 master
`);
    const result = await handler.execute({ epic_ref: '#100' });
    const parsed = parseResult(result);
    expect(parsed.count).toBe(2);
  });

  test('accepted_sections_surfaced_when_missing', async () => {
    mockBody('## Summary\nnothing here.\n');
    const result = await handler.execute({ epic_ref: '#100' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.count).toBe(0);
    expect(parsed.reason).toContain('no matching');
    expect(parsed.accepted_sections).toEqual(
      expect.arrayContaining(['sub_issues', 'waves', 'stories', 'phases']),
    );
  });

  test('sub_issues_section_takes_precedence_over_waves', async () => {
    // When both exist, the explicit sub_issues section wins.
    mockBody(`## Sub-Issues

- #5 explicit
- #6 explicit

## Waves

### Wave 1

- #99 secondary
`);
    const result = await handler.execute({ epic_ref: '#100' });
    const parsed = parseResult(result);
    expect(parsed.sub_issues.map((s: { ref: string }) => s.ref)).toEqual([
      'myorg/myrepo#5',
      'myorg/myrepo#6',
    ]);
  });
});
