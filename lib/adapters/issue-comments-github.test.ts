import { describe, test, expect, beforeEach } from 'bun:test';
import {
  installChildProcessMock,
  onExec as on,
  resetExecMock,
  execCalls,
} from '../test-support/mock-child-process.ts';

// Subprocess-boundary tests for the GitHub issueComments adapter (#613).

interface ThrowableError extends Error {
  stderr?: string;
  status?: number;
}

function unquote(cmd: string): string {
  return cmd.replace(/'([^']*)'/g, '$1');
}

installChildProcessMock();

const { issueCommentsGithub } = await import('./issue-comments-github.ts');

const line = (o: object) => JSON.stringify(JSON.stringify(o)).slice(1, -1).replace(/\\"/g, '"');

beforeEach(() => {
  resetExecMock();
});

describe('issueCommentsGithub — subprocess boundary', () => {
  test('argv: gh api comments endpoint, paginated, one JSON string per line', async () => {
    on('/comments', '');
    await issueCommentsGithub({ number: 42, repo: 'org/repo' });
    const call = unquote(execCalls().find((c) => c.includes('/comments')) ?? '');
    expect(call).toBe(
      'gh api repos/org/repo/issues/42/comments --paginate --jq .[] | {body, created_at, url: .html_url} | @json',
    );
  });

  test('no repo → gh {owner}/{repo} placeholders', async () => {
    on('/comments', '');
    await issueCommentsGithub({ number: 7 });
    const call = unquote(execCalls().find((c) => c.includes('/comments')) ?? '');
    expect(call).toContain('repos/{owner}/{repo}/issues/7/comments');
  });

  test('parses every line across pages, keeps url', async () => {
    on('/comments', [
      line({ body: '[ec-state EC-1] met', created_at: '2026-10-01T00:00:00Z', url: 'https://c/1' }),
      line({ body: 'second page', created_at: '2026-10-02T00:00:00Z', url: 'https://c/2' }),
      '',
    ].join('\n'));
    const r = await issueCommentsGithub({ number: 42, repo: 'org/repo' });
    expect(r).toEqual({
      ok: true,
      data: {
        number: 42,
        comments: [
          { body: '[ec-state EC-1] met', created_at: '2026-10-01T00:00:00Z', url: 'https://c/1' },
          { body: 'second page', created_at: '2026-10-02T00:00:00Z', url: 'https://c/2' },
        ],
      },
    });
  });

  test('no comments → empty list, ok', async () => {
    on('/comments', '');
    const r = await issueCommentsGithub({ number: 42, repo: 'org/repo' });
    expect(r).toEqual({ ok: true, data: { number: 42, comments: [] } });
  });

  test('gh failure → typed error with code', async () => {
    on('/comments', () => {
      const e: ThrowableError = new Error('boom');
      e.stderr = 'HTTP 404: Not Found';
      e.status = 1;
      throw e;
    });
    const r = await issueCommentsGithub({ number: 42, repo: 'org/repo' });
    expect(r).toMatchObject({ ok: false, code: 'gh_issue_comments_failed' });
    expect((r as { error: string }).error).toContain('404');
  });

  test('invalid slug is refused before any subprocess runs', async () => {
    const r = await issueCommentsGithub({ number: 1, repo: 'org/repo;rm -rf' });
    expect(r).toMatchObject({ ok: false, code: 'gh_issue_comments_failed' });
    expect(execCalls()).toEqual([]);
  });

  test('a line with no created_at fails rather than guessing an order', async () => {
    on('/comments', line({ body: 'x' }));
    const r = await issueCommentsGithub({ number: 42, repo: 'org/repo' });
    expect(r).toMatchObject({ ok: false, code: 'gh_issue_comments_failed' });
  });
});
