import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';

let execMockFn: (cmd: string) => string = () => '';
const mockExecSync = mock((cmd: string, _opts?: unknown) => execMockFn(cmd));
mock.module('child_process', () => ({ execSync: mockExecSync }));

const { default: handler } = await import('../handlers/spec_acceptance_criteria.ts');

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
    if (cmd.includes('gh issue view')) return JSON.stringify({ body });
    return '';
  };
}

describe('spec_acceptance_criteria handler', () => {
  beforeEach(resetMocks);
  afterEach(resetMocks);

  test('handler exports valid HandlerDef shape', () => {
    expect(handler.name).toBe('spec_acceptance_criteria');
    expect(typeof handler.execute).toBe('function');
  });

  test('parses_unchecked_items', async () => {
    mockBody(`## Acceptance Criteria

- [ ] criterion one
- [ ] criterion two
- [ ] criterion three
`);
    const result = await handler.execute({ issue_ref: '#1' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.count).toBe(3);
    expect(parsed.criteria.every((c: { checked: boolean }) => !c.checked)).toBe(true);
    expect(parsed.criteria[0].position).toBe(1);
    expect(parsed.criteria[2].position).toBe(3);
  });

  test('parses_checked_items', async () => {
    mockBody(`## Acceptance Criteria

- [x] done one
- [x] done two
`);
    const result = await handler.execute({ issue_ref: '#1' });
    const parsed = parseResult(result);
    expect(parsed.criteria.every((c: { checked: boolean }) => c.checked)).toBe(true);
  });

  test('mixed_checked_and_unchecked', async () => {
    mockBody(`## Acceptance Criteria

- [x] done
- [ ] todo
- [X] also done
`);
    const result = await handler.execute({ issue_ref: '#1' });
    const parsed = parseResult(result);
    expect(parsed.count).toBe(3);
    expect(parsed.criteria.map((c: { checked: boolean }) => c.checked)).toEqual([
      true,
      false,
      true,
    ]);
  });

  test('nested_items_flattened — nested bullets get sequential positions', async () => {
    mockBody(`## Acceptance Criteria

- [ ] outer
  - [ ] nested
- [ ] another outer
`);
    const result = await handler.execute({ issue_ref: '#1' });
    const parsed = parseResult(result);
    expect(parsed.count).toBe(3);
    expect(parsed.criteria.map((c: { position: number }) => c.position)).toEqual([1, 2, 3]);
  });

  test('no_ac_section_returns_empty_list', async () => {
    mockBody('## Summary\nstuff\n');
    const result = await handler.execute({ issue_ref: '#1' });
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.count).toBe(0);
    expect(parsed.criteria).toEqual([]);
  });

  test('schema_validation — rejects missing issue_ref', async () => {
    const result = await handler.execute({});
    const parsed = parseResult(result);
    expect(parsed.ok).toBe(false);
  });
});
