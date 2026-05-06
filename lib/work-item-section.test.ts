import { describe, test, expect } from 'bun:test';
import { spliceH2Section } from './work-item-section.ts';

describe('spliceH2Section', () => {
  test('replaces a middle H2 section while preserving siblings', () => {
    const body = [
      '## Summary',
      'short summary',
      '',
      '## Dependencies',
      '- old dep',
      '',
      '## Acceptance Criteria',
      '- [ ] do the thing',
    ].join('\n');

    const result = spliceH2Section(body, 'Dependencies', '- new dep\n- another dep');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toContain('## Summary');
    expect(result.body).toContain('short summary');
    expect(result.body).toContain('## Dependencies');
    expect(result.body).toContain('- new dep');
    expect(result.body).toContain('- another dep');
    expect(result.body).not.toContain('- old dep');
    expect(result.body).toContain('## Acceptance Criteria');
    expect(result.body).toContain('- [ ] do the thing');
  });

  test('replaces the LAST H2 section (no trailing H2 to anchor on)', () => {
    const body = ['## Summary', 'just summary', '', '## Notes', 'old notes'].join('\n');

    const result = spliceH2Section(body, 'Notes', 'new notes line');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toContain('new notes line');
    expect(result.body).not.toContain('old notes');
    expect(result.body).toContain('## Summary');
  });

  test('heading match is normalized (case + whitespace insensitive)', () => {
    const body = '##  Acceptance Criteria  \n- old\n';
    const result = spliceH2Section(body, 'acceptance criteria', '- new');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toContain('- new');
    expect(result.body).not.toContain('- old');
  });

  test('accepts heading with leading ## prefix', () => {
    const body = '## Foo\nold\n';
    const result = spliceH2Section(body, '## Foo', 'new');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toContain('new');
    expect(result.body).not.toContain('old');
  });

  test('returns error when section is missing', () => {
    const body = '## Summary\nx\n';
    const result = spliceH2Section(body, 'Dependencies', '- thing');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('Dependencies');
    expect(result.error).toContain('not found');
  });

  test('rejects empty heading', () => {
    const body = '## Foo\nx\n';
    const result = spliceH2Section(body, '   ', 'new');
    expect(result.ok).toBe(false);
  });

  test('preserves preamble before first H2 verbatim', () => {
    const body = ['<!-- some yaml -->', 'a paragraph', '', '## Body', 'old'].join('\n');
    const result = spliceH2Section(body, 'Body', 'new');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.startsWith('<!-- some yaml -->\na paragraph\n')).toBe(true);
    expect(result.body).toContain('new');
  });

  test('does not change body when only one section matches and content is identical', () => {
    const body = '## A\nfoo\n\n## B\nbar\n';
    const result = spliceH2Section(body, 'B', 'bar');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toContain('## A');
    expect(result.body).toContain('foo');
    expect(result.body).toContain('## B');
    expect(result.body).toContain('bar');
  });
});
