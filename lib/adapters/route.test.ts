import { describe, test, expect, beforeEach } from 'bun:test';
import {
  installChildProcessMock,
  setExecMock,
  resetExecMock,
  execCalls,
} from '../test-support/mock-child-process.ts';

installChildProcessMock();

const { getAdapter, platformFor, adapterFor } = await import('./route.ts');
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

// `platformFor` (#603) is the one inference both the adapter choice and any
// handler that needs the platform NAME share, so the two can never disagree.
describe('platformFor', () => {
  beforeEach(() => reset());

  test('nested-group repo means gitlab, without consulting cwd', () => {
    setExecMock(() => 'https://github.com/owner/repo.git');
    expect(platformFor({ repo: 'g/sub/proj' })).toBe('gitlab');
    expect(execCalls().length).toBe(0);
  });

  test('nested-group repo is gitlab when cwd is not a repo at all', () => {
    setExecMock(() => {
      throw new Error('not a git repository');
    });
    expect(platformFor({ repo: 'g/sub/proj' })).toBe('gitlab');
  });

  test('flat owner/repo falls back to cwd detection', () => {
    setExecMock(() => 'https://github.com/owner/repo.git');
    expect(platformFor({ repo: 'owner/repo' })).toBe('github');
    expect(execCalls().some((c) => c.includes('git remote get-url origin'))).toBe(true);
    setExecMock(() => 'https://gitlab.com/owner/repo.git');
    expect(platformFor({ repo: 'owner/repo' })).toBe('gitlab');
  });

  test('no repo falls back to cwd detection, github when origin is unreadable', () => {
    setExecMock(() => 'https://gitlab.com/owner/repo.git');
    expect(platformFor()).toBe('gitlab');
    expect(platformFor({})).toBe('gitlab');
    setExecMock(() => {
      throw new Error('not a git repository');
    });
    expect(platformFor()).toBe('github');
  });
});

describe('adapterFor', () => {
  test('maps each platform to its adapter', () => {
    expect(adapterFor('gitlab')).toBe(gitlabAdapter);
    expect(adapterFor('github')).toBe(githubAdapter);
  });

  test('getAdapter is adapterFor(platformFor) for every input shape', () => {
    const cases: Array<{ origin: string; repo?: string }> = [
      { origin: 'https://github.com/owner/repo.git', repo: 'g/sub/proj' },
      { origin: 'https://github.com/owner/repo.git', repo: 'owner/repo' },
      { origin: 'https://github.com/owner/repo.git' },
      { origin: 'https://gitlab.com/owner/repo.git', repo: 'owner/repo' },
      { origin: 'https://gitlab.com/owner/repo.git' },
    ];
    for (const { origin, repo } of cases) {
      setExecMock(() => origin);
      expect(getAdapter({ repo })).toBe(adapterFor(platformFor({ repo })));
    }
  });
});
