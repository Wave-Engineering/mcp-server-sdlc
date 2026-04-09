import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';

interface ExecCall {
  cmd: string;
  opts?: { encoding?: string; maxBuffer?: number };
}

let execCalls: ExecCall[] = [];
let execMockFn: (cmd: string, opts?: any) => string = () => '';
const mockExecSync = mock((cmd: string, opts?: any) => {
  execCalls.push({ cmd, opts });
  return execMockFn(cmd, opts);
});
mock.module('child_process', () => ({ execSync: mockExecSync }));

// Import after mocking
const {
  detectPlatform,
  parseRepoSlug,
  gitlabProjectPath,
  gitlabApiIssue,
  gitlabApiMr,
  gitlabApiMrList,
  gitlabApiCiList,
  gitlabApiRepo,
} = await import('../lib/glab.ts');

function resetMocks() {
  execCalls = [];
  execMockFn = () => '';
  mockExecSync.mockClear();
}

describe('glab adapter', () => {
  beforeEach(() => resetMocks());
  afterEach(() => resetMocks());

  describe('detectPlatform', () => {
    test('returns "gitlab" for gitlab.com URL', () => {
      execMockFn = (cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'https://gitlab.com/owner/repo.git';
        }
        return '';
      };
      expect(detectPlatform()).toBe('gitlab');
    });

    test('returns "gitlab" for self-hosted GitLab URL', () => {
      execMockFn = (cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'https://gitlab.company.com/owner/repo.git';
        }
        return '';
      };
      expect(detectPlatform()).toBe('gitlab');
    });

    test('returns "gitlab" for SSH GitLab URL', () => {
      execMockFn = (cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'git@gitlab.com:owner/repo.git';
        }
        return '';
      };
      expect(detectPlatform()).toBe('gitlab');
    });

    test('returns "github" for github.com URL', () => {
      execMockFn = (cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'https://github.com/owner/repo.git';
        }
        return '';
      };
      expect(detectPlatform()).toBe('github');
    });

    test('returns "github" for GitHub Enterprise URL', () => {
      execMockFn = (cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'https://github.company.com/owner/repo.git';
        }
        return '';
      };
      expect(detectPlatform()).toBe('github');
    });

    test('falls back to "github" when git remote fails', () => {
      execMockFn = () => {
        throw new Error('fatal: not a git repository');
      };
      expect(detectPlatform()).toBe('github');
    });

    test('falls back to "github" when remote is missing', () => {
      execMockFn = () => {
        throw new Error('fatal: No such remote');
      };
      expect(detectPlatform()).toBe('github');
    });
  });

  describe('parseRepoSlug', () => {
    test('parses HTTPS URL with .git suffix', () => {
      execMockFn = (cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'https://gitlab.com/owner/repo.git';
        }
        return '';
      };
      expect(parseRepoSlug()).toBe('owner/repo');
    });

    test('parses HTTPS URL without .git suffix', () => {
      execMockFn = (cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'https://gitlab.com/owner/repo';
        }
        return '';
      };
      expect(parseRepoSlug()).toBe('owner/repo');
    });

    test('parses SSH URL with .git suffix', () => {
      execMockFn = (cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'git@gitlab.com:owner/repo.git';
        }
        return '';
      };
      expect(parseRepoSlug()).toBe('owner/repo');
    });

    test('parses SSH URL without .git suffix', () => {
      execMockFn = (cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'git@gitlab.com:owner/repo';
        }
        return '';
      };
      expect(parseRepoSlug()).toBe('owner/repo');
    });

    test('parses URL with hyphens in owner/repo', () => {
      execMockFn = (cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'https://gitlab.com/my-org/my-repo.git';
        }
        return '';
      };
      expect(parseRepoSlug()).toBe('my-org/my-repo');
    });

    test('parses SSH URL with nested GitLab groups', () => {
      execMockFn = (cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'git@gitlab.com:analogicdev/internal/tools/perkollate.git';
        }
        return '';
      };
      expect(parseRepoSlug()).toBe('analogicdev/internal/tools/perkollate');
    });

    test('parses HTTPS URL with nested GitLab groups', () => {
      execMockFn = (cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'https://gitlab.com/org/sub/group/repo.git';
        }
        return '';
      };
      expect(parseRepoSlug()).toBe('org/sub/group/repo');
    });

    test('returns null when git remote fails', () => {
      execMockFn = () => {
        throw new Error('fatal: not a git repository');
      };
      expect(parseRepoSlug()).toBeNull();
    });

    test('returns null for malformed URL', () => {
      execMockFn = (cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'not-a-valid-url';
        }
        return '';
      };
      expect(parseRepoSlug()).toBeNull();
    });
  });

  describe('gitlabProjectPath', () => {
    test('returns URL-encoded project path', () => {
      execMockFn = (cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'https://gitlab.com/owner/repo.git';
        }
        return '';
      };
      expect(gitlabProjectPath()).toBe('owner%2Frepo');
    });

    test('handles URL encoding for special characters', () => {
      execMockFn = (cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'https://gitlab.com/my-org/my-repo.git';
        }
        return '';
      };
      expect(gitlabProjectPath()).toBe('my-org%2Fmy-repo');
    });

    test('throws when repo slug cannot be parsed', () => {
      execMockFn = () => {
        throw new Error('fatal: not a git repository');
      };
      expect(() => gitlabProjectPath()).toThrow('could not parse gitlab project path');
    });

    test('throws when URL is malformed', () => {
      execMockFn = (cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'not-a-valid-url';
        }
        return '';
      };
      expect(() => gitlabProjectPath()).toThrow('could not parse gitlab project path');
    });
  });

  describe('gitlabApiIssue', () => {
    test('fetches issue by IID', () => {
      execMockFn = (cmd: string) => {
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
      };

      const issue = gitlabApiIssue(42);
      expect(issue.iid).toBe(42);
      expect(issue.title).toBe('Test Issue');
      expect(issue.state).toBe('opened');
      expect(execCalls.some((c) => c.cmd === 'glab api projects/owner%2Frepo/issues/42')).toBe(
        true,
      );
    });

    test('uses owner/repo override when provided', () => {
      execMockFn = (cmd: string) => {
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
      };

      const issue = gitlabApiIssue(123, { owner: 'other', repo: 'project' });
      expect(issue.iid).toBe(123);
      expect(
        execCalls.some((c) => c.cmd === 'glab api projects/other%2Fproject/issues/123'),
      ).toBe(true);
    });

    test('propagates errors from glab CLI', () => {
      execMockFn = (cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'https://gitlab.com/owner/repo.git';
        }
        if (cmd.includes('glab api')) {
          throw new Error('404: Issue not found');
        }
        return '';
      };

      expect(() => gitlabApiIssue(999)).toThrow('404: Issue not found');
    });
  });

  describe('gitlabApiMr', () => {
    test('fetches MR by IID', () => {
      execMockFn = (cmd: string) => {
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
      };

      const mr = gitlabApiMr(17);
      expect(mr.iid).toBe(17);
      expect(mr.title).toBe('Test MR');
      expect(mr.source_branch).toBe('feature/test');
      expect(mr.target_branch).toBe('main');
      expect(
        execCalls.some((c) => c.cmd === 'glab api projects/owner%2Frepo/merge_requests/17'),
      ).toBe(true);
    });

    test('uses owner/repo override when provided', () => {
      execMockFn = (cmd: string) => {
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
      };

      const mr = gitlabApiMr(5, { owner: 'another', repo: 'repo' });
      expect(mr.iid).toBe(5);
      expect(
        execCalls.some((c) => c.cmd === 'glab api projects/another%2Frepo/merge_requests/5'),
      ).toBe(true);
    });

    test('propagates errors from glab CLI', () => {
      execMockFn = (cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'https://gitlab.com/owner/repo.git';
        }
        if (cmd.includes('glab api')) {
          throw new Error('404: Merge request not found');
        }
        return '';
      };

      expect(() => gitlabApiMr(999)).toThrow('404: Merge request not found');
    });
  });

  describe('gitlabApiMrList', () => {
    test('lists MRs with no filters', () => {
      execMockFn = (cmd: string) => {
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
      };

      const mrs = gitlabApiMrList({});
      expect(mrs).toHaveLength(1);
      expect(mrs[0].iid).toBe(1);
      expect(execCalls.some((c) => c.cmd === 'glab api projects/owner%2Frepo/merge_requests')).toBe(
        true,
      );
    });

    test('translates state "open" to "opened"', () => {
      execMockFn = (cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'https://gitlab.com/owner/repo.git';
        }
        if (cmd.includes('glab api')) {
          return JSON.stringify([]);
        }
        return '';
      };

      gitlabApiMrList({ state: 'open' });
      expect(
        execCalls.some((c) =>
          c.cmd.includes('glab api projects/owner%2Frepo/merge_requests?state=opened'),
        ),
      ).toBe(true);
    });

    test('translates state "closed" to "closed"', () => {
      execMockFn = (cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'https://gitlab.com/owner/repo.git';
        }
        if (cmd.includes('glab api')) {
          return JSON.stringify([]);
        }
        return '';
      };

      gitlabApiMrList({ state: 'closed' });
      expect(
        execCalls.some((c) =>
          c.cmd.includes('glab api projects/owner%2Frepo/merge_requests?state=closed'),
        ),
      ).toBe(true);
    });

    test('translates state "merged" to "merged"', () => {
      execMockFn = (cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'https://gitlab.com/owner/repo.git';
        }
        if (cmd.includes('glab api')) {
          return JSON.stringify([]);
        }
        return '';
      };

      gitlabApiMrList({ state: 'merged' });
      expect(
        execCalls.some((c) =>
          c.cmd.includes('glab api projects/owner%2Frepo/merge_requests?state=merged'),
        ),
      ).toBe(true);
    });

    test('omits state param when state is "all"', () => {
      execMockFn = (cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'https://gitlab.com/owner/repo.git';
        }
        if (cmd.includes('glab api')) {
          return JSON.stringify([]);
        }
        return '';
      };

      gitlabApiMrList({ state: 'all' });
      const apiCall = execCalls.find((c) => c.cmd.includes('glab api'));
      expect(apiCall?.cmd).toBe('glab api projects/owner%2Frepo/merge_requests');
      expect(apiCall?.cmd).not.toContain('state=');
    });

    test('includes head (source_branch) filter', () => {
      execMockFn = (cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'https://gitlab.com/owner/repo.git';
        }
        if (cmd.includes('glab api')) {
          return JSON.stringify([]);
        }
        return '';
      };

      gitlabApiMrList({ head: 'feature/test' });
      expect(
        execCalls.some((c) => c.cmd.includes('source_branch=feature%2Ftest')),
      ).toBe(true);
    });

    test('includes base (target_branch) filter', () => {
      execMockFn = (cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'https://gitlab.com/owner/repo.git';
        }
        if (cmd.includes('glab api')) {
          return JSON.stringify([]);
        }
        return '';
      };

      gitlabApiMrList({ base: 'develop' });
      expect(execCalls.some((c) => c.cmd.includes('target_branch=develop'))).toBe(true);
    });

    test('includes author filter', () => {
      execMockFn = (cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'https://gitlab.com/owner/repo.git';
        }
        if (cmd.includes('glab api')) {
          return JSON.stringify([]);
        }
        return '';
      };

      gitlabApiMrList({ author: 'testuser' });
      expect(execCalls.some((c) => c.cmd.includes('author_username=testuser'))).toBe(true);
    });

    test('includes limit (per_page) filter', () => {
      execMockFn = (cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'https://gitlab.com/owner/repo.git';
        }
        if (cmd.includes('glab api')) {
          return JSON.stringify([]);
        }
        return '';
      };

      gitlabApiMrList({ limit: 50 });
      expect(execCalls.some((c) => c.cmd.includes('per_page=50'))).toBe(true);
    });

    test('combines multiple filters', () => {
      execMockFn = (cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'https://gitlab.com/owner/repo.git';
        }
        if (cmd.includes('glab api')) {
          return JSON.stringify([]);
        }
        return '';
      };

      gitlabApiMrList({
        state: 'open',
        head: 'feature/test',
        base: 'main',
        author: 'dev',
        limit: 10,
      });
      const apiCall = execCalls.find((c) => c.cmd.includes('glab api'));
      expect(apiCall?.cmd).toContain('state=opened');
      expect(apiCall?.cmd).toContain('source_branch=feature%2Ftest');
      expect(apiCall?.cmd).toContain('target_branch=main');
      expect(apiCall?.cmd).toContain('author_username=dev');
      expect(apiCall?.cmd).toContain('per_page=10');
    });
  });

  describe('gitlabApiCiList', () => {
    test('lists pipelines with no filters', () => {
      execMockFn = (cmd: string) => {
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
      };

      const pipelines = gitlabApiCiList({});
      expect(pipelines).toHaveLength(1);
      expect(pipelines[0].id).toBe(123);
      expect(execCalls.some((c) => c.cmd === 'glab api projects/owner%2Frepo/pipelines')).toBe(
        true,
      );
    });

    test('includes ref filter', () => {
      execMockFn = (cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'https://gitlab.com/owner/repo.git';
        }
        if (cmd.includes('glab api')) {
          return JSON.stringify([]);
        }
        return '';
      };

      gitlabApiCiList({ ref: 'feature/test' });
      expect(execCalls.some((c) => c.cmd.includes('ref=feature%2Ftest'))).toBe(true);
    });

    test('includes limit (per_page) filter', () => {
      execMockFn = (cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'https://gitlab.com/owner/repo.git';
        }
        if (cmd.includes('glab api')) {
          return JSON.stringify([]);
        }
        return '';
      };

      gitlabApiCiList({ limit: 20 });
      expect(execCalls.some((c) => c.cmd.includes('per_page=20'))).toBe(true);
    });

    test('combines ref and limit filters', () => {
      execMockFn = (cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'https://gitlab.com/owner/repo.git';
        }
        if (cmd.includes('glab api')) {
          return JSON.stringify([]);
        }
        return '';
      };

      gitlabApiCiList({ ref: 'main', limit: 5 });
      const apiCall = execCalls.find((c) => c.cmd.includes('glab api'));
      expect(apiCall?.cmd).toContain('ref=main');
      expect(apiCall?.cmd).toContain('per_page=5');
    });
  });

  describe('gitlabApiRepo', () => {
    test('fetches current project metadata', () => {
      execMockFn = (cmd: string) => {
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
      };

      const repo = gitlabApiRepo();
      expect(repo.id).toBe(456);
      expect(repo.name).toBe('repo');
      expect(repo.path_with_namespace).toBe('owner/repo');
      expect(repo.default_branch).toBe('main');
      expect(execCalls.some((c) => c.cmd === 'glab api projects/owner%2Frepo')).toBe(true);
    });

    test('propagates errors from glab CLI', () => {
      execMockFn = (cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'https://gitlab.com/owner/repo.git';
        }
        if (cmd.includes('glab api')) {
          throw new Error('404: Project not found');
        }
        return '';
      };

      expect(() => gitlabApiRepo()).toThrow('404: Project not found');
    });
  });

  describe('execGlab internal behavior', () => {
    test('sets maxBuffer to 64MB for glab api calls', () => {
      execMockFn = (cmd: string) => {
        if (cmd === 'git remote get-url origin') {
          return 'https://gitlab.com/owner/repo.git';
        }
        if (cmd.includes('glab api')) {
          return JSON.stringify({ id: 1 });
        }
        return '';
      };

      gitlabApiRepo();
      const glabCall = execCalls.find((c) => c.cmd.includes('glab api'));
      expect(glabCall?.opts?.maxBuffer).toBe(1024 * 1024 * 64);
    });
  });
});
