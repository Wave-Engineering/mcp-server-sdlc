import { describe, test, expect, beforeEach } from 'bun:test';
import {
  installChildProcessMock,
  onExec as on,
  resetExecMock,
  execCalls,
} from '../test-support/mock-child-process.ts';

// Subprocess-boundary tests for the GitLab issueComments adapter (#613).
// Argv strictness per `lesson_origin_ops_pitfalls.md`: glab api with explicit
// GET and `-f` query fields, no gh-style flags, no `--paginate`.

function unquote(cmd: string): string {
  return cmd.replace(/'([^']*)'/g, '$1');
}

installChildProcessMock();

const { issueCommentsGitlab } = await import('./issue-comments-gitlab.ts');

const note = (id: number, body: string, system = false) => ({
  id,
  body,
  system,
  created_at: `2026-10-01T00:00:${String(id % 60).padStart(2, '0')}Z`,
});

beforeEach(() => {
  resetExecMock();
});

describe('issueCommentsGitlab — subprocess boundary', () => {
  test('argv: glab api notes, explicit GET, ascending, first page', async () => {
    on('/notes', '[]');
    await issueCommentsGitlab({ number: 42, repo: 'group/sub/proj' });
    const call = unquote(execCalls()[0] ?? '');
    expect(call).toBe(
      'glab api projects/group%2Fsub%2Fproj/issues/42/notes -X GET -f sort=asc -f order_by=created_at -f per_page=100 -f page=1',
    );
    expect(call).not.toContain('--paginate');
  });

  test('drops system notes', async () => {
    on('/notes', JSON.stringify([note(1, 'added label'), note(2, '[ec-state EC-1] met')].map((n, i) => ({ ...n, system: i === 0 }))));
    const r = await issueCommentsGitlab({ number: 42, repo: 'g/p' });
    expect(r).toEqual({
      ok: true,
      data: { number: 42, comments: [{ body: '[ec-state EC-1] met', created_at: note(2, '').created_at }] },
    });
  });

  test('walks pages until a short page', async () => {
    const full = Array.from({ length: 100 }, (_, i) => note(i + 1, `n${i + 1}`));
    // Leading space: a bare `page=1` also matches inside `per_page=100`.
    on(' page=1', JSON.stringify(full));
    on(' page=2', JSON.stringify([note(101, 'last')]));
    const r = await issueCommentsGitlab({ number: 42, repo: 'g/p' });
    if (!('ok' in r) || !r.ok) throw new Error(JSON.stringify(r));
    expect(r.data.comments).toHaveLength(101);
    expect(r.data.comments[100].body).toBe('last');
    expect(execCalls()).toHaveLength(2);
  });

  test('refuses a truncated list past the page cap', async () => {
    const full = JSON.stringify(Array.from({ length: 100 }, (_, i) => note(i + 1, 'x')));
    on('/notes', full);
    const r = await issueCommentsGitlab({ number: 42, repo: 'g/p' });
    expect(r).toMatchObject({ ok: false, code: 'glab_issue_comments_failed' });
    expect((r as { error: string }).error).toContain('refusing to return a truncated list');
  });

  test('API error body → typed error with code', async () => {
    on('/notes', JSON.stringify({ message: '404 Not found' }));
    const r = await issueCommentsGitlab({ number: 42, repo: 'g/p' });
    expect(r).toMatchObject({ ok: false, code: 'glab_issue_comments_failed' });
  });
});
