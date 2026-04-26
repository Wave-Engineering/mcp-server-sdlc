import { describe, test, expect } from 'bun:test';

// Pure-function tests for the parsers lifted from handlers/epic_sub_issues.ts
// during Story 2.6 (#300). No mock.module needed — these parsers operate on
// already-extracted section strings and never touch platform/subprocess code.

import {
  normalizeRef,
  parseTableRows,
  parseChecklistOrBullets,
} from './epic-sub-issues-parser.ts';

describe('epic-sub-issues-parser — ref normalization', () => {
  test('github URL collapses to org/repo#N', () => {
    expect(
      normalizeRef('https://github.com/Wave-Engineering/mcp-server-sdlc/issues/42', null),
    ).toBe('Wave-Engineering/mcp-server-sdlc#42');
  });

  test('gitlab URL (with /-/issues/) collapses to group/project#N', () => {
    expect(
      normalizeRef('https://gitlab.com/mygroup/myproject/-/issues/12', null),
    ).toBe('mygroup/myproject#12');
  });

  test('already-qualified cross-repo ref passes through unchanged', () => {
    expect(normalizeRef('acme/widgets#7', 'myorg/myrepo')).toBe('acme/widgets#7');
  });

  test('bare #N is qualified against currentSlug when provided', () => {
    expect(normalizeRef('#5', 'myorg/myrepo')).toBe('myorg/myrepo#5');
  });

  test('bare N (no hash) is also qualified against currentSlug', () => {
    expect(normalizeRef('5', 'myorg/myrepo')).toBe('myorg/myrepo#5');
  });

  test('bare #N stays bare when currentSlug is null', () => {
    expect(normalizeRef('#5', null)).toBe('#5');
  });

  test('unparseable input is returned verbatim', () => {
    expect(normalizeRef('not a ref', 'myorg/myrepo')).toBe('not a ref');
  });
});

describe('epic-sub-issues-parser — table row extraction', () => {
  test('extracts order/issue/title from a standard 3-column table', () => {
    const section = `| Order | Issue | Title |
|-------|-------|-------|
| 1 | #5 | wave_init |
| 2 | #6 | wave_preflight |
`;
    const rows = parseTableRows(section, 'myorg/myrepo');
    expect(rows).toEqual([
      { ref: 'myorg/myrepo#5', title: 'wave_init', order: 1 },
      { ref: 'myorg/myrepo#6', title: 'wave_preflight', order: 2 },
    ]);
  });

  test('preserves order values from the Order column (not row position)', () => {
    const section = `| Order | Issue |
|-------|-------|
| 3 | #5 |
| 1 | #6 |
| 2 | #7 |
`;
    const rows = parseTableRows(section, 'myorg/myrepo');
    expect(rows.map(r => r.order)).toEqual([3, 1, 2]);
  });

  test('cross-repo refs in table cells pass through verbatim', () => {
    const section = `| Order | Issue | Title |
|-------|-------|-------|
| 1 | Wave-Engineering/other#42 | cross repo |
`;
    const rows = parseTableRows(section, 'myorg/myrepo');
    expect(rows[0].ref).toBe('Wave-Engineering/other#42');
  });

  test('rows without a parseable ref are skipped', () => {
    const section = `| Order | Issue | Title |
|-------|-------|-------|
| 1 | TBD | pending |
| 2 | #7 | real |
`;
    const rows = parseTableRows(section, 'myorg/myrepo');
    expect(rows).toEqual([
      { ref: 'myorg/myrepo#7', title: 'real', order: 2 },
    ]);
  });

  test('returns [] when the section has no pipe-delimited header', () => {
    expect(parseTableRows('just prose, no table here', null)).toEqual([]);
  });

  test('title/order cells are optional — only issue column required', () => {
    const section = `| Issue |
|-------|
| #9 |
`;
    const rows = parseTableRows(section, 'myorg/myrepo');
    expect(rows).toEqual([{ ref: 'myorg/myrepo#9', title: undefined, order: undefined }]);
  });
});

describe('epic-sub-issues-parser — checklist/bullet extraction', () => {
  test('parses checklist items `- [ ] #N Title` and `- [x] #N Title`', () => {
    const section = `- [ ] #5 wave_init
- [x] #6 wave_preflight
`;
    const rows = parseChecklistOrBullets(section, 'myorg/myrepo');
    expect(rows).toEqual([
      { ref: 'myorg/myrepo#5', title: 'wave_init', order: 1 },
      { ref: 'myorg/myrepo#6', title: 'wave_preflight', order: 2 },
    ]);
  });

  test('parses plain bullet items `- #N Title`', () => {
    const section = `- #5 wave_init
- #6 wave_preflight
`;
    const rows = parseChecklistOrBullets(section, 'myorg/myrepo');
    expect(rows[0]).toEqual({ ref: 'myorg/myrepo#5', title: 'wave_init', order: 1 });
    expect(rows[1].order).toBe(2);
  });

  test('strips em/en dashes + other separators from the title', () => {
    const section = `- #86 — Story 1.1: Pipeline config schema
- #87 – Story 1.2: Pipeline config loader
`;
    const rows = parseChecklistOrBullets(section, 'myorg/myrepo');
    expect(rows[0].title).toBe('Story 1.1: Pipeline config schema');
    expect(rows[1].title).toBe('Story 1.2: Pipeline config loader');
  });

  test('cross-repo refs in bullets pass through verbatim', () => {
    const section = `- Wave-Engineering/other#42 cross-repo task
`;
    const rows = parseChecklistOrBullets(section, 'myorg/myrepo');
    expect(rows[0].ref).toBe('Wave-Engineering/other#42');
  });

  test('full issue URL in a bullet is normalized', () => {
    const section = `- https://github.com/acme/widgets/issues/7 widget work
`;
    const rows = parseChecklistOrBullets(section, 'myorg/myrepo');
    expect(rows[0].ref).toBe('acme/widgets#7');
  });

  test('bullets without any ref are skipped (position counter does not advance)', () => {
    const section = `- just prose, no ref
- #5 first real
- another prose line
- #6 second real
`;
    const rows = parseChecklistOrBullets(section, 'myorg/myrepo');
    expect(rows.map(r => r.order)).toEqual([1, 2]);
    expect(rows.map(r => r.ref)).toEqual(['myorg/myrepo#5', 'myorg/myrepo#6']);
  });

  test('returns [] on a section with no bullets', () => {
    expect(parseChecklistOrBullets('just a paragraph of prose.', null)).toEqual([]);
  });
});
