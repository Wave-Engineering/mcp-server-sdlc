import { describe, test, expect, mock, beforeEach } from 'bun:test';

let execMockFn: (cmd: string) => string = () => '';
const mockExecSync = mock((cmd: string) => execMockFn(cmd));
mock.module('child_process', () => ({ execSync: mockExecSync }));

const { parseRepoSlug } = await import('./parse-repo-slug.ts');

function reset() {
  execMockFn = () => '';
  mockExecSync.mockClear();
}

describe('parseRepoSlug (lib/shared/)', () => {
  beforeEach(() => reset());

  test('parses HTTPS GitHub URL', () => {
    execMockFn = () => 'https://github.com/owner/repo.git';
    expect(parseRepoSlug()).toBe('owner/repo');
  });

  test('parses HTTPS GitLab URL', () => {
    execMockFn = () => 'https://gitlab.com/owner/repo.git';
    expect(parseRepoSlug()).toBe('owner/repo');
  });

  test('parses SSH GitHub URL', () => {
    execMockFn = () => 'git@github.com:owner/repo.git';
    expect(parseRepoSlug()).toBe('owner/repo');
  });

  test('parses SSH GitLab URL', () => {
    execMockFn = () => 'git@gitlab.com:owner/repo.git';
    expect(parseRepoSlug()).toBe('owner/repo');
  });

  test('parses URL without .git suffix', () => {
    execMockFn = () => 'https://github.com/owner/repo';
    expect(parseRepoSlug()).toBe('owner/repo');
  });

  test('parses deeply nested GitLab group path', () => {
    execMockFn = () => 'https://gitlab.com/org/sub/group/repo.git';
    expect(parseRepoSlug()).toBe('org/sub/group/repo');
  });

  test('parses self-hosted GitLab SSH with nested path', () => {
    execMockFn = () => 'git@gitlab.company.com:team/project/sub/repo.git';
    expect(parseRepoSlug()).toBe('team/project/sub/repo');
  });

  test('returns null when origin cannot be read', () => {
    execMockFn = () => {
      throw new Error('not a git repository');
    };
    expect(parseRepoSlug()).toBeNull();
  });

  test('returns null when URL does not match expected pattern', () => {
    execMockFn = () => 'this-is-not-a-git-url';
    expect(parseRepoSlug()).toBeNull();
  });

  // Helper-move regression test (per Story 1.2 AC):
  // proves the function still works when imported from its new lib/shared/
  // location — the goal of the move was to share without coupling to lib/glab.ts.
  test('helper-move regression: import works from lib/shared/', () => {
    execMockFn = () => 'https://github.com/Wave-Engineering/mcp-server-sdlc.git';
    expect(parseRepoSlug()).toBe('Wave-Engineering/mcp-server-sdlc');
  });
});
