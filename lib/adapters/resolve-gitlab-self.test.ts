import { describe, test, expect, beforeEach } from 'bun:test';
import {
  installChildProcessMock,
  onExec,
  resetExecMock,
  execCalls,
} from '../test-support/mock-child-process.ts';

// Subprocess-boundary tests for the GitLab self-user resolver (#577). It backs
// the self-assign-at-creation comfort: glab's `--assignee` takes a username, so
// the current user is resolved via `glab api /user`. NON-FATAL by contract —
// any failure returns null so the caller creates the MR unassigned rather than
// failing.

installChildProcessMock();

const { resolveGitlabSelfSync } = await import('./resolve-gitlab-self.ts');

beforeEach(() => {
  resetExecMock();
});

describe('resolveGitlabSelfSync', () => {
  test('returns the username from a `glab api /user` payload', () => {
    onExec('glab api /user', JSON.stringify({ id: 40378227, username: 'bj-bots', name: 'BJ' }));
    expect(resolveGitlabSelfSync()).toBe('bj-bots');
    // Must query the authenticated user, not a project-scoped endpoint. Recorded
    // commands are shell-escaped, so match the quoted argv form.
    expect(execCalls().some((c) => c.includes("'glab' 'api' '/user'"))).toBe(true);
  });

  test('runs glab in the supplied cwd', () => {
    onExec('glab api /user', JSON.stringify({ username: 'someone' }));
    resolveGitlabSelfSync('/work/tree');
    // opts.cwd is asserted via the detailed call in sibling suites; here we only
    // need to confirm the value round-trips without throwing.
    expect(resolveGitlabSelfSync('/work/tree')).toBe('someone');
  });

  test('returns null when glab exits non-zero (unauthed/offline) — never throws', () => {
    onExec('glab api /user', () => {
      const err = new Error('glab: 401 unauthorized') as Error & { status?: number; stderr?: string };
      err.status = 1;
      err.stderr = 'glab: 401 unauthorized';
      throw err;
    });
    expect(resolveGitlabSelfSync()).toBeNull();
  });

  test('returns null on empty stdout', () => {
    onExec('glab api /user', '');
    expect(resolveGitlabSelfSync()).toBeNull();
  });

  test('returns null on malformed JSON', () => {
    onExec('glab api /user', 'not json at all');
    expect(resolveGitlabSelfSync()).toBeNull();
  });

  test('returns null when username is missing or empty', () => {
    onExec('glab api /user', JSON.stringify({ id: 1, name: 'No Username' }));
    expect(resolveGitlabSelfSync()).toBeNull();
  });
});
