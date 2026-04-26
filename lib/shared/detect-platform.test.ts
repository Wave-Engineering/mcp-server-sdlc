import { describe, test, expect, mock, beforeEach } from 'bun:test';

let execMockFn: (cmd: string) => string = () => '';
const mockExecSync = mock((cmd: string) => execMockFn(cmd));
mock.module('child_process', () => ({ execSync: mockExecSync }));

const { detectPlatform, detectPlatformForRef } = await import('./detect-platform.ts');

function reset() {
  execMockFn = () => '';
  mockExecSync.mockClear();
}

describe('detectPlatform (lib/shared/)', () => {
  beforeEach(() => reset());

  test('returns "gitlab" for gitlab.com origin', () => {
    execMockFn = () => 'https://gitlab.com/owner/repo.git';
    expect(detectPlatform()).toBe('gitlab');
  });

  test('returns "gitlab" for self-hosted GitLab origin', () => {
    execMockFn = () => 'https://gitlab.company.com/owner/repo.git';
    expect(detectPlatform()).toBe('gitlab');
  });

  test('returns "gitlab" for SSH GitLab origin', () => {
    execMockFn = () => 'git@gitlab.com:owner/repo.git';
    expect(detectPlatform()).toBe('gitlab');
  });

  test('returns "github" for github.com origin', () => {
    execMockFn = () => 'https://github.com/owner/repo.git';
    expect(detectPlatform()).toBe('github');
  });

  test('returns "github" for GitHub Enterprise origin', () => {
    execMockFn = () => 'https://github.acme.com/owner/repo.git';
    expect(detectPlatform()).toBe('github');
  });

  test('falls back to "github" when origin cannot be read', () => {
    execMockFn = () => {
      throw new Error('not a git repository');
    };
    expect(detectPlatform()).toBe('github');
  });
});

describe('detectPlatformForRef (lib/shared/)', () => {
  beforeEach(() => reset());

  test('returns "gitlab" for multi-segment owner path (nested groups)', () => {
    expect(
      detectPlatformForRef({ owner: 'org/sub/group', repo: 'repo', number: 1 }),
    ).toBe('gitlab');
  });

  test('falls back to cwd detection for single-segment owner', () => {
    execMockFn = () => 'https://github.com/owner/repo.git';
    expect(detectPlatformForRef({ owner: 'owner', repo: 'repo', number: 1 })).toBe(
      'github',
    );
  });

  test('falls back to cwd detection for local refs (no owner)', () => {
    execMockFn = () => 'https://gitlab.com/owner/repo.git';
    expect(detectPlatformForRef({ owner: null, repo: null, number: 42 })).toBe(
      'gitlab',
    );
  });
});
