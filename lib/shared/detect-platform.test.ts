import { describe, test, expect, beforeEach } from 'bun:test';
import {
  installChildProcessMock,
  setExecMock,
  resetExecMock,
} from '../test-support/mock-child-process.ts';

installChildProcessMock();

const { detectPlatform, detectPlatformForRef } = await import('./detect-platform.ts');

function reset() {
  resetExecMock();
  setExecMock(() => '');
}

describe('detectPlatform (lib/shared/)', () => {
  beforeEach(() => reset());

  test('returns "gitlab" for gitlab.com origin', () => {
    setExecMock(() => 'https://gitlab.com/owner/repo.git');
    expect(detectPlatform()).toBe('gitlab');
  });

  test('returns "gitlab" for self-hosted GitLab origin', () => {
    setExecMock(() => 'https://gitlab.company.com/owner/repo.git');
    expect(detectPlatform()).toBe('gitlab');
  });

  test('returns "gitlab" for SSH GitLab origin', () => {
    setExecMock(() => 'git@gitlab.com:owner/repo.git');
    expect(detectPlatform()).toBe('gitlab');
  });

  test('returns "github" for github.com origin', () => {
    setExecMock(() => 'https://github.com/owner/repo.git');
    expect(detectPlatform()).toBe('github');
  });

  test('returns "github" for GitHub Enterprise origin', () => {
    setExecMock(() => 'https://github.acme.com/owner/repo.git');
    expect(detectPlatform()).toBe('github');
  });

  test('falls back to "github" when origin cannot be read', () => {
    setExecMock(() => {
      throw new Error('not a git repository');
    });
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
    setExecMock(() => 'https://github.com/owner/repo.git');
    expect(detectPlatformForRef({ owner: 'owner', repo: 'repo', number: 1 })).toBe(
      'github',
    );
  });

  test('falls back to cwd detection for local refs (no owner)', () => {
    setExecMock(() => 'https://gitlab.com/owner/repo.git');
    expect(detectPlatformForRef({ owner: null, repo: null, number: 42 })).toBe(
      'gitlab',
    );
  });
});
