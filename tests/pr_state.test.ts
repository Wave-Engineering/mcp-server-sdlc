import { describe, test, expect, mock, beforeEach } from 'bun:test';

let execCalls: string[] = [];
let execMockFn: (cmd: string) => string = () => '';
const mockExecSync = mock((cmd: string) => {
  execCalls.push(cmd);
  return execMockFn(cmd);
});
mock.module('child_process', () => ({ execSync: mockExecSync }));

const { fetchPrState, fetchGithubPrState, fetchGitlabMrState } = await import(
  '../lib/pr_state.ts'
);

function reset() {
  execCalls = [];
  execMockFn = () => '';
  mockExecSync.mockClear();
}

describe('pr_state', () => {
  beforeEach(() => reset());

  describe('fetchGithubPrState', () => {
    test('parses MERGED state with merge commit sha', () => {
      execMockFn = () =>
        JSON.stringify({
          state: 'MERGED',
          url: 'https://github.com/org/repo/pull/42',
          mergeCommit: { oid: 'deadbeef' },
        });
      const info = fetchGithubPrState(42);
      expect(info.state).toBe('merged');
      expect(info.url).toBe('https://github.com/org/repo/pull/42');
      expect(info.mergeCommitSha).toBe('deadbeef');
    });

    test('parses OPEN state with no merge commit', () => {
      execMockFn = () =>
        JSON.stringify({
          state: 'OPEN',
          url: 'https://github.com/org/repo/pull/42',
          mergeCommit: null,
        });
      const info = fetchGithubPrState(42);
      expect(info.state).toBe('open');
      expect(info.mergeCommitSha).toBeUndefined();
    });

    test('parses CLOSED state', () => {
      execMockFn = () =>
        JSON.stringify({
          state: 'CLOSED',
          url: 'https://github.com/org/repo/pull/42',
          mergeCommit: null,
        });
      const info = fetchGithubPrState(42);
      expect(info.state).toBe('closed');
    });

    test('passes --repo when supplied', () => {
      execMockFn = () =>
        JSON.stringify({ state: 'OPEN', url: '', mergeCommit: null });
      fetchGithubPrState(42, 'org/other-repo');
      expect(execCalls[0]).toContain('--repo org/other-repo');
    });

    test('omits --repo when not supplied (uses cwd)', () => {
      execMockFn = () =>
        JSON.stringify({ state: 'OPEN', url: '', mergeCommit: null });
      fetchGithubPrState(42);
      expect(execCalls[0]).not.toContain('--repo');
    });

    test('unknown state defaults to open', () => {
      execMockFn = () =>
        JSON.stringify({ state: 'WEIRD', url: '', mergeCommit: null });
      expect(fetchGithubPrState(42).state).toBe('open');
    });

    test('rejects malicious repo slug at lib boundary (no exec)', () => {
      expect(() => fetchGithubPrState(42, 'org/repo; rm -rf /')).toThrow(
        /invalid repo slug/,
      );
      expect(execCalls.length).toBe(0);
    });

    test('rejects repo slug with shell metacharacter (no exec)', () => {
      expect(() => fetchGithubPrState(42, 'org/repo`whoami`')).toThrow(
        /invalid repo slug/,
      );
      expect(execCalls.length).toBe(0);
    });

    test('rejects repo with no slash (no exec)', () => {
      expect(() => fetchGithubPrState(42, 'just-a-name')).toThrow(/invalid repo slug/);
      expect(execCalls.length).toBe(0);
    });
  });

  describe('fetchGitlabMrState', () => {
    test('parses merged state via glab api', () => {
      execMockFn = (cmd: string) => {
        if (cmd.includes('git remote get-url')) {
          return 'https://gitlab.com/org/repo.git\n';
        }
        return JSON.stringify({
          state: 'merged',
          web_url: 'https://gitlab.com/org/repo/-/merge_requests/7',
          merge_commit_sha: 'cafebabe',
        });
      };
      const info = fetchGitlabMrState(7);
      expect(info.state).toBe('merged');
      expect(info.url).toBe('https://gitlab.com/org/repo/-/merge_requests/7');
      expect(info.mergeCommitSha).toBe('cafebabe');
    });

    test('parses opened state', () => {
      execMockFn = (cmd: string) => {
        if (cmd.includes('git remote get-url')) {
          return 'https://gitlab.com/org/repo.git\n';
        }
        return JSON.stringify({
          state: 'opened',
          web_url: 'https://gitlab.com/org/repo/-/merge_requests/7',
        });
      };
      const info = fetchGitlabMrState(7);
      expect(info.state).toBe('open');
      expect(info.mergeCommitSha).toBeUndefined();
    });
  });

  describe('fetchPrState dispatcher', () => {
    test('dispatches to github when platform=github', () => {
      execMockFn = () =>
        JSON.stringify({ state: 'OPEN', url: '', mergeCommit: null });
      fetchPrState('github', 42);
      expect(execCalls[0]).toContain('gh pr view 42');
    });

    test('dispatches to gitlab when platform=gitlab', () => {
      execMockFn = (cmd: string) => {
        if (cmd.includes('git remote get-url')) {
          return 'https://gitlab.com/org/repo.git\n';
        }
        return JSON.stringify({ state: 'opened', web_url: '' });
      };
      fetchPrState('gitlab', 7);
      const calls = execCalls.join('\n');
      expect(calls).toContain('glab api');
    });
  });
});
