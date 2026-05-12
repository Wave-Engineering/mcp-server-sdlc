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

  test('2-segment repo falls back to cwd detection (github origin)', () => {
    execMockFn = () => 'https://github.com/owner/repo.git';
    expect(getAdapter({ repo: 'Wave-Engineering/ccwork-testtarget' })).toBe(githubAdapter);
  });

  test('2-segment repo falls back to cwd detection (gitlab origin)', () => {
    execMockFn = () => 'https://gitlab.com/owner/repo.git';
    expect(getAdapter({ repo: 'some-org/some-repo' })).toBe(gitlabAdapter);
  });

  test('3+-segment repo routes to gitlab regardless of cwd', () => {
    execMockFn = () => 'https://github.com/owner/repo.git';
    expect(getAdapter({ repo: 'analogicdev/blueshift/blueshift-cue' })).toBe(gitlabAdapter);
  });

  test('deeply nested repo routes to gitlab', () => {
    execMockFn = () => 'https://github.com/owner/repo.git';
    expect(getAdapter({ repo: 'analogicdev/internal/tools/blueshift/blueshift-cue' })).toBe(gitlabAdapter);
  });
});
