import { describe, test, expect, beforeEach } from 'bun:test';
import {
  installChildProcessMock,
  setExecMock,
  resetExecMock,
} from '../test-support/mock-child-process.ts';

installChildProcessMock();

const { parseRepoSlug } = await import('./parse-repo-slug.ts');

function reset() {
  resetExecMock();
  setExecMock(() => '');
}

describe('parseRepoSlug (lib/shared/)', () => {
  beforeEach(() => reset());

  test('parses HTTPS GitHub URL', () => {
    setExecMock(() => 'https://github.com/owner/repo.git');
    expect(parseRepoSlug()).toBe('owner/repo');
  });

  test('parses HTTPS GitLab URL', () => {
    setExecMock(() => 'https://gitlab.com/owner/repo.git');
    expect(parseRepoSlug()).toBe('owner/repo');
  });

  test('parses SSH GitHub URL', () => {
    setExecMock(() => 'git@github.com:owner/repo.git');
    expect(parseRepoSlug()).toBe('owner/repo');
  });

  test('parses SSH GitLab URL', () => {
    setExecMock(() => 'git@gitlab.com:owner/repo.git');
    expect(parseRepoSlug()).toBe('owner/repo');
  });

  test('parses URL without .git suffix', () => {
    setExecMock(() => 'https://github.com/owner/repo');
    expect(parseRepoSlug()).toBe('owner/repo');
  });

  test('parses deeply nested GitLab group path', () => {
    setExecMock(() => 'https://gitlab.com/org/sub/group/repo.git');
    expect(parseRepoSlug()).toBe('org/sub/group/repo');
  });

  test('parses self-hosted GitLab SSH with nested path', () => {
    setExecMock(() => 'git@gitlab.company.com:team/project/sub/repo.git');
    expect(parseRepoSlug()).toBe('team/project/sub/repo');
  });

  test('returns null when origin cannot be read', () => {
    setExecMock(() => {
      throw new Error('not a git repository');
    });
    expect(parseRepoSlug()).toBeNull();
  });

  test('returns null when URL does not match expected pattern', () => {
    setExecMock(() => 'this-is-not-a-git-url');
    expect(parseRepoSlug()).toBeNull();
  });

  // Helper-move regression test (per Story 1.2 AC):
  // proves the function still works when imported from its new lib/shared/
  // location — the goal of the move was to share without coupling to the
  // GitLab-specific REST wrapper module.
  test('helper-move regression: import works from lib/shared/', () => {
    setExecMock(() => 'https://github.com/Wave-Engineering/mcp-server-sdlc.git');
    expect(parseRepoSlug()).toBe('Wave-Engineering/mcp-server-sdlc');
  });
});
