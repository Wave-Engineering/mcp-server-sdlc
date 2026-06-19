/**
 * Tests for `lib/gitlab-api.ts` — the GitLab REST (`glab api`) typed wrappers.
 *
 * `detectPlatform` and `parseRepoSlug` coverage lives in
 * `lib/shared/detect-platform.test.ts` and `lib/shared/parse-repo-slug.test.ts`
 * respectively.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  installChildProcessMock,
  setExecMock,
  resetExecMock,
  execCallsDetailed,
} from '../lib/test-support/mock-child-process.ts';

installChildProcessMock();

// Import after mocking
const {
  gitlabProjectPath,
  gitlabApiIssue,
  gitlabApiMr,
  gitlabApiMrList,
  gitlabApiCiList,
  gitlabApiRepo,
} = await import('../lib/gitlab-api.ts');

function resetMocks() {
  resetExecMock();
  setExecMock(() => '');
}

describe('gitlab-api', () => {
  beforeEach(() => resetMocks());
  afterEach(() => resetMocks());

  describe('gitlabProjectPath', () => {
    test('returns URL-encoded project path', () => {
      setExecMock((cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'https://gitlab.com/owner/repo.git';
        }
        return '';
      });
      expect(gitlabProjectPath()).toBe('owner%2Frepo');
    });

    test('handles URL encoding for special characters', () => {
      setExecMock((cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'https://gitlab.com/my-org/my-repo.git';
        }
        return '';
      });
      expect(gitlabProjectPath()).toBe('my-org%2Fmy-repo');
    });

    test('throws when repo slug cannot be parsed', () => {
      setExecMock(() => {
        throw new Error('fatal: not a git repository');
      });
      expect(() => gitlabProjectPath()).toThrow('could not parse gitlab project path');
    });

    test('throws when URL is malformed', () => {
      setExecMock((cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'not-a-valid-url';
        }
        return '';
      });
      expect(() => gitlabProjectPath()).toThrow('could not parse gitlab project path');
    });
  });

  describe('gitlabApiIssue', () => {
    test('fetches issue by IID', () => {
      setExecMock((cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'https://gitlab.com/owner/repo.git';
        }
        if (cmd.includes('glab api')) {
          return JSON.stringify({
            iid: 42,
            title: 'Test Issue',
            description: 'Test description',
            state: 'opened',
            labels: ['bug'],
            web_url: 'https://gitlab.com/owner/repo/-/issues/42',
          });
        }
        return '';
      });

      const issue = gitlabApiIssue(42);
      expect(issue.iid).toBe(42);
      expect(issue.title).toBe('Test Issue');
      expect(issue.state).toBe('opened');
      expect(execCallsDetailed().some((c) => c.cmd === 'glab api projects/owner%2Frepo/issues/42')).toBe(
        true,
      );
    });

    test('uses owner/repo override when provided', () => {
      setExecMock((cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'https://gitlab.com/owner/repo.git';
        }
        if (cmd.includes('glab api')) {
          return JSON.stringify({
            iid: 123,
            title: 'Override Issue',
            description: null,
            state: 'closed',
            labels: [],
            web_url: 'https://gitlab.com/other/project/-/issues/123',
          });
        }
        return '';
      });

      const issue = gitlabApiIssue(123, { owner: 'other', repo: 'project' });
      expect(issue.iid).toBe(123);
      expect(
        execCallsDetailed().some((c) => c.cmd === 'glab api projects/other%2Fproject/issues/123'),
      ).toBe(true);
    });

    test('propagates errors from glab CLI', () => {
      setExecMock((cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'https://gitlab.com/owner/repo.git';
        }
        if (cmd.includes('glab api')) {
          throw new Error('404: Issue not found');
        }
        return '';
      });

      expect(() => gitlabApiIssue(999)).toThrow('404: Issue not found');
    });
  });

  describe('gitlabApiMr', () => {
    test('fetches MR by IID', () => {
      setExecMock((cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'https://gitlab.com/owner/repo.git';
        }
        if (cmd.includes('glab api')) {
          return JSON.stringify({
            iid: 17,
            title: 'Test MR',
            description: 'Test MR description',
            state: 'opened',
            source_branch: 'feature/test',
            target_branch: 'main',
            web_url: 'https://gitlab.com/owner/repo/-/merge_requests/17',
            labels: ['enhancement'],
          });
        }
        return '';
      });

      const mr = gitlabApiMr(17);
      expect(mr.iid).toBe(17);
      expect(mr.title).toBe('Test MR');
      expect(mr.source_branch).toBe('feature/test');
      expect(mr.target_branch).toBe('main');
      expect(
        execCallsDetailed().some((c) => c.cmd === 'glab api projects/owner%2Frepo/merge_requests/17'),
      ).toBe(true);
    });

    test('uses owner/repo override when provided', () => {
      setExecMock((cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'https://gitlab.com/owner/repo.git';
        }
        if (cmd.includes('glab api')) {
          return JSON.stringify({
            iid: 5,
            title: 'Override MR',
            description: null,
            state: 'merged',
            source_branch: 'fix/bug',
            target_branch: 'main',
            web_url: 'https://gitlab.com/another/repo/-/merge_requests/5',
            labels: [],
          });
        }
        return '';
      });

      const mr = gitlabApiMr(5, { owner: 'another', repo: 'repo' });
      expect(mr.iid).toBe(5);
      expect(
        execCallsDetailed().some((c) => c.cmd === 'glab api projects/another%2Frepo/merge_requests/5'),
      ).toBe(true);
    });

    test('propagates errors from glab CLI', () => {
      setExecMock((cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'https://gitlab.com/owner/repo.git';
        }
        if (cmd.includes('glab api')) {
          throw new Error('404: Merge request not found');
        }
        return '';
      });

      expect(() => gitlabApiMr(999)).toThrow('404: Merge request not found');
    });
  });

  describe('gitlabApiMrList', () => {
    test('lists MRs with no filters', () => {
      setExecMock((cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'https://gitlab.com/owner/repo.git';
        }
        if (cmd.includes('glab api')) {
          return JSON.stringify([
            {
              iid: 1,
              title: 'MR 1',
              description: null,
              state: 'opened',
              source_branch: 'feat/1',
              target_branch: 'main',
              web_url: 'https://gitlab.com/owner/repo/-/merge_requests/1',
              labels: [],
            },
          ]);
        }
        return '';
      });

      const mrs = gitlabApiMrList({});
      expect(mrs).toHaveLength(1);
      expect(mrs[0].iid).toBe(1);
      expect(execCallsDetailed().some((c) => c.cmd === 'glab api projects/owner%2Frepo/merge_requests')).toBe(
        true,
      );
    });

    test('translates state "open" to "opened"', () => {
      setExecMock((cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'https://gitlab.com/owner/repo.git';
        }
        if (cmd.includes('glab api')) {
          return JSON.stringify([]);
        }
        return '';
      });

      gitlabApiMrList({ state: 'open' });
      expect(
        execCallsDetailed().some((c) =>
          c.cmd.includes('glab api projects/owner%2Frepo/merge_requests?state=opened'),
        ),
      ).toBe(true);
    });

    test('translates state "closed" to "closed"', () => {
      setExecMock((cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'https://gitlab.com/owner/repo.git';
        }
        if (cmd.includes('glab api')) {
          return JSON.stringify([]);
        }
        return '';
      });

      gitlabApiMrList({ state: 'closed' });
      expect(
        execCallsDetailed().some((c) =>
          c.cmd.includes('glab api projects/owner%2Frepo/merge_requests?state=closed'),
        ),
      ).toBe(true);
    });

    test('translates state "merged" to "merged"', () => {
      setExecMock((cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'https://gitlab.com/owner/repo.git';
        }
        if (cmd.includes('glab api')) {
          return JSON.stringify([]);
        }
        return '';
      });

      gitlabApiMrList({ state: 'merged' });
      expect(
        execCallsDetailed().some((c) =>
          c.cmd.includes('glab api projects/owner%2Frepo/merge_requests?state=merged'),
        ),
      ).toBe(true);
    });

    test('omits state param when state is "all"', () => {
      setExecMock((cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'https://gitlab.com/owner/repo.git';
        }
        if (cmd.includes('glab api')) {
          return JSON.stringify([]);
        }
        return '';
      });

      gitlabApiMrList({ state: 'all' });
      const apiCall = execCallsDetailed().find((c) => c.cmd.includes('glab api'));
      expect(apiCall?.cmd).toBe('glab api projects/owner%2Frepo/merge_requests');
      expect(apiCall?.cmd).not.toContain('state=');
    });

    test('includes head (source_branch) filter', () => {
      setExecMock((cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'https://gitlab.com/owner/repo.git';
        }
        if (cmd.includes('glab api')) {
          return JSON.stringify([]);
        }
        return '';
      });

      gitlabApiMrList({ head: 'feature/test' });
      expect(
        execCallsDetailed().some((c) => c.cmd.includes('source_branch=feature%2Ftest')),
      ).toBe(true);
    });

    test('includes base (target_branch) filter', () => {
      setExecMock((cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'https://gitlab.com/owner/repo.git';
        }
        if (cmd.includes('glab api')) {
          return JSON.stringify([]);
        }
        return '';
      });

      gitlabApiMrList({ base: 'develop' });
      expect(execCallsDetailed().some((c) => c.cmd.includes('target_branch=develop'))).toBe(true);
    });

    test('includes author filter', () => {
      setExecMock((cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'https://gitlab.com/owner/repo.git';
        }
        if (cmd.includes('glab api')) {
          return JSON.stringify([]);
        }
        return '';
      });

      gitlabApiMrList({ author: 'testuser' });
      expect(execCallsDetailed().some((c) => c.cmd.includes('author_username=testuser'))).toBe(true);
    });

    test('includes limit (per_page) filter', () => {
      setExecMock((cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'https://gitlab.com/owner/repo.git';
        }
        if (cmd.includes('glab api')) {
          return JSON.stringify([]);
        }
        return '';
      });

      gitlabApiMrList({ limit: 50 });
      expect(execCallsDetailed().some((c) => c.cmd.includes('per_page=50'))).toBe(true);
    });

    test('combines multiple filters', () => {
      setExecMock((cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'https://gitlab.com/owner/repo.git';
        }
        if (cmd.includes('glab api')) {
          return JSON.stringify([]);
        }
        return '';
      });

      gitlabApiMrList({
        state: 'open',
        head: 'feature/test',
        base: 'main',
        author: 'dev',
        limit: 10,
      });
      const apiCall = execCallsDetailed().find((c) => c.cmd.includes('glab api'));
      expect(apiCall?.cmd).toContain('state=opened');
      expect(apiCall?.cmd).toContain('source_branch=feature%2Ftest');
      expect(apiCall?.cmd).toContain('target_branch=main');
      expect(apiCall?.cmd).toContain('author_username=dev');
      expect(apiCall?.cmd).toContain('per_page=10');
    });
  });

  describe('gitlabApiCiList', () => {
    test('lists pipelines with no filters', () => {
      setExecMock((cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'https://gitlab.com/owner/repo.git';
        }
        if (cmd.includes('glab api')) {
          return JSON.stringify([
            {
              id: 123,
              sha: 'abc123',
              ref: 'main',
              status: 'success',
              web_url: 'https://gitlab.com/owner/repo/-/pipelines/123',
            },
          ]);
        }
        return '';
      });

      const pipelines = gitlabApiCiList({});
      expect(pipelines).toHaveLength(1);
      expect(pipelines[0].id).toBe(123);
      expect(execCallsDetailed().some((c) => c.cmd === 'glab api projects/owner%2Frepo/pipelines')).toBe(
        true,
      );
    });

    test('includes ref filter', () => {
      setExecMock((cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'https://gitlab.com/owner/repo.git';
        }
        if (cmd.includes('glab api')) {
          return JSON.stringify([]);
        }
        return '';
      });

      gitlabApiCiList({ ref: 'feature/test' });
      expect(execCallsDetailed().some((c) => c.cmd.includes('ref=feature%2Ftest'))).toBe(true);
    });

    test('includes limit (per_page) filter', () => {
      setExecMock((cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'https://gitlab.com/owner/repo.git';
        }
        if (cmd.includes('glab api')) {
          return JSON.stringify([]);
        }
        return '';
      });

      gitlabApiCiList({ limit: 20 });
      expect(execCallsDetailed().some((c) => c.cmd.includes('per_page=20'))).toBe(true);
    });

    test('combines ref and limit filters', () => {
      setExecMock((cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'https://gitlab.com/owner/repo.git';
        }
        if (cmd.includes('glab api')) {
          return JSON.stringify([]);
        }
        return '';
      });

      gitlabApiCiList({ ref: 'main', limit: 5 });
      const apiCall = execCallsDetailed().find((c) => c.cmd.includes('glab api'));
      expect(apiCall?.cmd).toContain('ref=main');
      expect(apiCall?.cmd).toContain('per_page=5');
    });
  });

  describe('gitlabApiRepo', () => {
    test('fetches current project metadata', () => {
      setExecMock((cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'https://gitlab.com/owner/repo.git';
        }
        if (cmd.includes('glab api')) {
          return JSON.stringify({
            id: 456,
            name: 'repo',
            path: 'repo',
            path_with_namespace: 'owner/repo',
            web_url: 'https://gitlab.com/owner/repo',
            default_branch: 'main',
            visibility: 'public',
          });
        }
        return '';
      });

      const repo = gitlabApiRepo();
      expect(repo.id).toBe(456);
      expect(repo.name).toBe('repo');
      expect(repo.path_with_namespace).toBe('owner/repo');
      expect(repo.default_branch).toBe('main');
      expect(execCallsDetailed().some((c) => c.cmd === 'glab api projects/owner%2Frepo')).toBe(true);
    });

    test('propagates errors from glab CLI', () => {
      setExecMock((cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'https://gitlab.com/owner/repo.git';
        }
        if (cmd.includes('glab api')) {
          throw new Error('404: Project not found');
        }
        return '';
      });

      expect(() => gitlabApiRepo()).toThrow('404: Project not found');
    });
  });

  describe('execGlab internal behavior', () => {
    test('sets maxBuffer to 64MB for glab api calls', () => {
      setExecMock((cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'https://gitlab.com/owner/repo.git';
        }
        if (cmd.includes('glab api')) {
          return JSON.stringify({ id: 1 });
        }
        return '';
      });

      gitlabApiRepo();
      const glabCall = execCallsDetailed().find((c) => c.cmd.includes('glab api'));
      expect((glabCall?.opts as { maxBuffer?: number } | undefined)?.maxBuffer).toBe(1024 * 1024 * 64);
    });
  });

  // execGlab is internal but its failure-mode behavior is observable through
  // every wrapper. Test through gitlabApiIssue as the canonical entrypoint
  // (#382 — empty-stdout produced cryptic "JSON Parse error: Unexpected EOF",
  // and non-zero exit lost stderr context).
  describe('execGlab (failure-mode behavior, observed via gitlabApiIssue)', () => {
    test('non-zero exit with stderr is surfaced as named error including command and stderr', () => {
      setExecMock((cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'https://gitlab.com/owner/repo.git';
        }
        if (cmd.includes('glab api')) {
          const err = new Error('Command failed') as Error & {
            stderr?: string;
            status?: number;
          };
          err.stderr = '401 Unauthorized';
          err.status = 1;
          throw err;
        }
        return '';
      });

      expect(() => gitlabApiIssue(7)).toThrow(/glab failed \(exit 1\):.*glab api projects/);
      expect(() => gitlabApiIssue(7)).toThrow(/stderr: 401 Unauthorized/);
    });

    test('zero-exit empty-stdout throws a named error instead of letting JSON.parse explode', () => {
      setExecMock((cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'https://gitlab.com/owner/repo.git';
        }
        if (cmd.includes('glab api')) {
          return ''; // the polyjuice failure mode
        }
        return '';
      });

      // Must NOT get "JSON Parse error: Unexpected EOF" — must get the
      // descriptive "empty output" message that names the failing command.
      expect(() => gitlabApiIssue(7)).toThrow(/glab returned empty output for: glab api projects/);
      expect(() => gitlabApiIssue(7)).not.toThrow(/Unexpected EOF/);
    });

    test('plain Error (no stderr, no status) re-throws unchanged for backward compat', () => {
      setExecMock((cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'https://gitlab.com/owner/repo.git';
        }
        if (cmd.includes('glab api')) {
          throw new Error('404: Issue not found');
        }
        return '';
      });

      // The existing "propagates errors from glab CLI" test case shape:
      // a bare Error with neither stderr nor status should pass through
      // untouched so existing callers expecting verbatim messages still work.
      expect(() => gitlabApiIssue(999)).toThrow('404: Issue not found');
    });
  });
});
