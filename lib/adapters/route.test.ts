import { describe, test, expect, beforeEach } from 'bun:test';
import {
  installChildProcessMock,
  setExecMock,
  resetExecMock,
} from '../test-support/mock-child-process.ts';

installChildProcessMock();

const { getAdapter } = await import('./route.ts');
const { githubAdapter } = await import('./github.ts');
const { gitlabAdapter } = await import('./gitlab.ts');

function reset() {
  resetExecMock();
  setExecMock(() => '');
}

describe('getAdapter dispatch', () => {
  beforeEach(() => reset());

  test('returns githubAdapter for github.com origin', () => {
    setExecMock(() => 'https://github.com/owner/repo.git');
    expect(getAdapter()).toBe(githubAdapter);
  });

  test('returns gitlabAdapter for gitlab.com origin', () => {
    setExecMock(() => 'https://gitlab.com/owner/repo.git');
    expect(getAdapter()).toBe(gitlabAdapter);
  });

  test('returns gitlabAdapter for self-hosted GitLab origin', () => {
    setExecMock(() => 'https://gitlab.acme.com/owner/repo.git');
    expect(getAdapter()).toBe(gitlabAdapter);
  });

  test('falls back to github when origin is unreadable', () => {
    setExecMock(() => {
      throw new Error('not a git repository');
    });
    expect(getAdapter()).toBe(githubAdapter);
  });

  test('2-segment repo falls back to cwd detection (github origin)', () => {
    setExecMock(() => 'https://github.com/owner/repo.git');
    expect(getAdapter({ repo: 'Wave-Engineering/ccwork-testtarget' })).toBe(githubAdapter);
  });

  test('2-segment repo falls back to cwd detection (gitlab origin)', () => {
    setExecMock(() => 'https://gitlab.com/owner/repo.git');
    expect(getAdapter({ repo: 'some-org/some-repo' })).toBe(gitlabAdapter);
  });

  test('3+-segment repo routes to gitlab regardless of cwd', () => {
    setExecMock(() => 'https://github.com/owner/repo.git');
    expect(getAdapter({ repo: 'analogicdev/blueshift/blueshift-cue' })).toBe(gitlabAdapter);
  });

  test('deeply nested repo routes to gitlab', () => {
    setExecMock(() => 'https://github.com/owner/repo.git');
    expect(getAdapter({ repo: 'analogicdev/internal/tools/blueshift/blueshift-cue' })).toBe(gitlabAdapter);
  });
});
