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
});
