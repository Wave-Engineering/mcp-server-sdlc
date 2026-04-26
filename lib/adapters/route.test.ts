import { describe, test, expect, mock, beforeEach } from 'bun:test';

let execMockFn: (cmd: string) => string = () => '';
const mockExecSync = mock((cmd: string) => execMockFn(cmd));
mock.module('child_process', () => ({ execSync: mockExecSync }));

const { getAdapter } = await import('./route.ts');
const { githubAdapter } = await import('./github.ts');
const { gitlabAdapter } = await import('./gitlab.ts');

function reset() {
  execMockFn = () => '';
  mockExecSync.mockClear();
}

describe('getAdapter dispatch', () => {
  beforeEach(() => reset());

  test('returns githubAdapter for github.com origin', () => {
    execMockFn = () => 'https://github.com/owner/repo.git';
    expect(getAdapter()).toBe(githubAdapter);
  });

  test('returns gitlabAdapter for gitlab.com origin', () => {
    execMockFn = () => 'https://gitlab.com/owner/repo.git';
    expect(getAdapter()).toBe(gitlabAdapter);
  });

  test('returns gitlabAdapter for self-hosted GitLab origin', () => {
    execMockFn = () => 'https://gitlab.acme.com/owner/repo.git';
    expect(getAdapter()).toBe(gitlabAdapter);
  });

  test('falls back to github when origin is unreadable', () => {
    execMockFn = () => {
      throw new Error('not a git repository');
    };
    expect(getAdapter()).toBe(githubAdapter);
  });

  test('accepts {repo} arg without throwing (forward-compat for cross-repo dispatch)', () => {
    execMockFn = () => 'https://github.com/owner/repo.git';
    expect(getAdapter({ repo: 'org/somewhere-else' })).toBe(githubAdapter);
  });
});
