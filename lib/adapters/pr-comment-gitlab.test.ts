import { describe, test, expect, beforeEach } from 'bun:test';
import {
  installChildProcessMock,
  onExec,
  resetExecMock,
  execCalls,
} from '../test-support/mock-child-process.ts';
import type { AdapterResult, PrCommentResponse } from './types.ts';

// Subprocess-boundary tests for the GitLab pr_comment adapter (R-15).
// Integration-level coverage stays in tests/pr_comment.test.ts.

interface ThrowableError extends Error {
  stderr?: string;
  stdout?: string;
  status?: number;
}

function unquote(cmd: string): string {
  return cmd.replace(/'([^']*)'/g, '$1');
}

installChildProcessMock();

const { prCommentGitlab } = await import('./pr-comment-gitlab.ts');

function expectOk(
  r: AdapterResult<PrCommentResponse>,
): asserts r is { ok: true; data: PrCommentResponse } {
  if (!('ok' in r) || !r.ok) {
    throw new Error(`expected ok result, got ${JSON.stringify(r)}`);
  }
}

function expectErr(
  r: AdapterResult<PrCommentResponse>,
): asserts r is { ok: false; error: string; code: string } {
  if (!('ok' in r) || r.ok) {
    throw new Error(`expected error result, got ${JSON.stringify(r)}`);
  }
}

function findCall(needle: string): string {
  return execCalls().find((c) => c.includes(needle) || unquote(c).includes(needle)) ?? '';
}

beforeEach(() => {
  resetExecMock();
});

describe('prCommentGitlab — subprocess boundary', () => {
  test('glab CLI invocation matches expected argv shape (happy path)', async () => {
    onExec(
      'glab mr note',
      'https://gitlab.com/org/repo/-/merge_requests/55#note_9090\n',
    );

    const result = await prCommentGitlab({ number: 55, body: 'ship it' });
    expectOk(result);
    expect(result.data.comment_id).toBe(9090);
    expect(result.data.number).toBe(55);
    expect(result.data.url).toBe('https://gitlab.com/org/repo/-/merge_requests/55#note_9090');

    const glabCall = findCall('glab mr note');
    expect(glabCall).toContain('glab');
    expect(glabCall).toContain('mr');
    expect(glabCall).toContain('note');
    expect(glabCall).toContain('55');
    // GitLab uses --message, not --body
    expect(glabCall).toContain('--message');
    expect(glabCall).toContain('ship it');
    // No -R when args.repo omitted
    expect(glabCall).not.toContain("'-R'");
  });

  test('multi-line markdown body is preserved verbatim through shell-escape', async () => {
    onExec(
      'glab mr note',
      'https://gitlab.com/org/repo/-/merge_requests/88#note_7070\n',
    );

    const body = [
      '### Review findings',
      '',
      '```python',
      'def hello():',
      '    print("world")',
      '```',
      '',
      '- bullet one',
      '- bullet two',
    ].join('\n');

    const result = await prCommentGitlab({ number: 88, body });
    expectOk(result);
    expect(result.data.comment_id).toBe(7070);

    // Body survives shell-escaping: each line should be present verbatim in
    // the unquoted command. Single-quoted shell tokens preserve newlines.
    const glabCall = findCall('glab mr note');
    const flat = unquote(glabCall);
    expect(flat).toContain('### Review findings');
    expect(flat).toContain('```python');
    expect(flat).toContain('def hello():');
    expect(flat).toContain('print("world")');
    expect(flat).toContain('- bullet one');
    expect(flat).toContain('- bullet two');
  });

  test('parses note ID from #note_<id> URL fragment', async () => {
    onExec(
      'glab mr note',
      'https://gitlab.example.com/team/proj/-/merge_requests/11#note_2222\n',
    );

    const result = await prCommentGitlab({ number: 11, body: 'hi' });
    expectOk(result);
    expect(result.data.comment_id).toBe(2222);
    expect(result.data.url).toBe('https://gitlab.example.com/team/proj/-/merge_requests/11#note_2222');
  });

  test('returns AdapterResult{ok:false, code} on glab failure (not thrown)', async () => {
    onExec('glab mr note', () => {
      const err = new Error('permission denied') as ThrowableError;
      err.stderr = 'permission denied';
      err.status = 1;
      throw err;
    });

    const result = await prCommentGitlab({ number: 9999, body: 'nope' });
    expectErr(result);
    expect(result.code).toBe('glab_mr_note_failed');
    expect(result.error).toContain('glab mr note failed');
    expect(result.error).toContain('permission denied');
  });

  test('returns parse-failure code when stdout lacks #note_<id>', async () => {
    onExec('glab mr note', 'posted note ok\n');

    const result = await prCommentGitlab({ number: 1, body: 'x' });
    expectErr(result);
    expect(result.code).toBe('glab_note_id_parse_failed');
    expect(result.error).toContain('failed to parse note ID');
  });

  test('-R flag forwarded when args.repo provided (GitLab uses -R, not --repo)', async () => {
    onExec(
      'glab mr note',
      'https://gitlab.com/target-org/target-repo/-/merge_requests/55#note_9090\n',
    );

    await prCommentGitlab({
      number: 55,
      body: 'cross-repo',
      repo: 'target-org/target-repo',
    });

    const glabCall = findCall('glab mr note');
    expect(glabCall).toContain('-R');
    expect(glabCall).toContain('target-org/target-repo');
  });

  test('target:"issue" routes to glab issue note (#430)', async () => {
    onExec(
      'glab issue note',
      'https://gitlab.com/org/repo/-/issues/2#note_5555\n',
    );

    const result = await prCommentGitlab({ number: 2, body: 'ledger entry', target: 'issue' });
    expectOk(result);
    expect(result.data.comment_id).toBe(5555);
    expect(result.data.number).toBe(2);
    expect(result.data.url).toBe('https://gitlab.com/org/repo/-/issues/2#note_5555');

    const glabCall = findCall('glab issue note');
    expect(glabCall).toContain('issue');
    expect(glabCall).toContain('note');
    expect(glabCall).not.toContain('mr');
  });

  test('target:"mr" explicitly routes to glab mr note', async () => {
    onExec(
      'glab mr note',
      'https://gitlab.com/org/repo/-/merge_requests/3#note_6666\n',
    );

    const result = await prCommentGitlab({ number: 3, body: 'lgtm', target: 'mr' });
    expectOk(result);
    expect(result.data.comment_id).toBe(6666);

    const glabCall = findCall('glab mr note');
    expect(glabCall).toContain('mr');
  });

  test('target omitted defaults to mr (backwards compat)', async () => {
    onExec(
      'glab mr note',
      'https://gitlab.com/org/repo/-/merge_requests/10#note_7777\n',
    );

    const result = await prCommentGitlab({ number: 10, body: 'default' });
    expectOk(result);

    const glabCall = findCall('glab mr note');
    expect(glabCall).toContain('mr');
  });

  test('target:"issue" failure returns glab_issue_note_failed code', async () => {
    onExec('glab issue note', () => {
      const err = new Error('not found') as ThrowableError;
      err.stderr = 'not found';
      err.status = 1;
      throw err;
    });

    const result = await prCommentGitlab({ number: 99, body: 'x', target: 'issue' });
    expectErr(result);
    expect(result.code).toBe('glab_issue_note_failed');
  });
});
