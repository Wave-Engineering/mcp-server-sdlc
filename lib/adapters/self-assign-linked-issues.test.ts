import { describe, test, expect, beforeEach } from 'bun:test';
import {
  installChildProcessMock,
  onExec,
  resetExecMock,
  execCalls,
} from '../test-support/mock-child-process.ts';

// Unit tests for the linked-issue self-assign at PR/MR creation (#578): the
// close-ref parser, both platform assigners (additive, non-fatal), and the
// response merge helper.

installChildProcessMock();

const {
  parseCloseRefs,
  selfAssignLinkedIssuesGithub,
  selfAssignLinkedIssuesGitlab,
  withLinkedAssign,
} = await import('./self-assign-linked-issues.ts');

beforeEach(() => {
  resetExecMock();
});

describe('parseCloseRefs', () => {
  test('matches close / fix / resolve and their tenses, case-insensitively', () => {
    expect(parseCloseRefs('Closes #12')).toEqual([12]);
    expect(parseCloseRefs('fixes #13 and resolves #14')).toEqual([13, 14]);
    expect(parseCloseRefs('Closed #1, FIXED #2, Resolves #3')).toEqual([1, 2, 3]);
    expect(parseCloseRefs('fix #7')).toEqual([7]);
  });

  test('dedupes repeated refs, order-preserving', () => {
    expect(parseCloseRefs('Closes #5 and closes #5 again, fixes #6')).toEqual([5, 6]);
  });

  test('does NOT match non-close mentions', () => {
    expect(parseCloseRefs('see #99, related to #88, part of #77')).toEqual([]);
    expect(parseCloseRefs('discussion in #42')).toEqual([]);
  });

  test('handles empty / undefined bodies', () => {
    expect(parseCloseRefs('')).toEqual([]);
    expect(parseCloseRefs(undefined)).toEqual([]);
  });
});

describe('selfAssignLinkedIssuesGithub', () => {
  test('emits `gh issue edit <N> --add-assignee @me` per ref (additive)', () => {
    onExec('gh issue edit 12', 'https://github.com/o/r/issues/12\n');
    onExec('gh issue edit 13', 'https://github.com/o/r/issues/13\n');

    const r = selfAssignLinkedIssuesGithub('Closes #12, fixes #13', '/w', undefined);
    expect(r.assigned).toEqual([12, 13]);
    expect(r.warnings).toEqual([]);
    const call = execCalls().find((c) => c.includes("'gh' 'issue' 'edit' '12'")) ?? '';
    expect(call).toContain("'--add-assignee' '@me'");
  });

  test('forwards --repo when supplied', () => {
    onExec('gh issue edit 5', 'ok\n');
    selfAssignLinkedIssuesGithub('Closes #5', '/w', 'owner/repo');
    const call = execCalls().find((c) => c.includes("'gh' 'issue' 'edit' '5'")) ?? '';
    expect(call).toContain("'--repo' 'owner/repo'");
  });

  test('a failing assign is non-fatal — warned, others still assigned', () => {
    onExec('gh issue edit 12', 'ok\n');
    onExec('gh issue edit 13', () => {
      const err = new Error('gh: not found') as Error & { status?: number; stderr?: string };
      err.status = 1;
      err.stderr = 'gh: not found';
      throw err;
    });

    const r = selfAssignLinkedIssuesGithub('Closes #12, closes #13', '/w', undefined);
    expect(r.assigned).toEqual([12]);
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]).toContain('#13');
  });

  test('no refs → no subprocess calls', () => {
    const r = selfAssignLinkedIssuesGithub('just a description', '/w', undefined);
    expect(r).toEqual({ assigned: [], warnings: [] });
    expect(execCalls().length).toBe(0);
  });
});

describe('selfAssignLinkedIssuesGitlab', () => {
  test('resolves self then emits `glab issue update <N> --assignee +<user>` (additive)', () => {
    onExec('glab api /user', JSON.stringify({ username: 'bj-bots' }));
    onExec('glab issue update 12', 'ok\n');
    onExec('glab issue update 13', 'ok\n');

    const r = selfAssignLinkedIssuesGitlab('Closes #12, fixes #13', '/w', undefined);
    expect(r.assigned).toEqual([12, 13]);
    expect(r.warnings).toEqual([]);
    const call = execCalls().find((c) => c.includes("'glab' 'issue' 'update' '12'")) ?? '';
    expect(call).toContain("'--assignee' '+bj-bots'");
  });

  test('forwards -R when supplied', () => {
    onExec('glab api /user', JSON.stringify({ username: 'bj-bots' }));
    onExec('glab issue update 5', 'ok\n');
    selfAssignLinkedIssuesGitlab('Closes #5', '/w', 'grp/proj');
    const call = execCalls().find((c) => c.includes("'glab' 'issue' 'update' '5'")) ?? '';
    expect(call).toContain("'-R' 'grp/proj'");
  });

  test('null self-resolution → warns and assigns nothing (never queries update)', () => {
    // No `glab api /user` stub → unmatched → resolveGitlabSelfSync returns null.
    const r = selfAssignLinkedIssuesGitlab('Closes #12', '/w', undefined);
    expect(r.assigned).toEqual([]);
    expect(r.warnings.length).toBe(1);
    expect(execCalls().some((c) => c.includes('glab issue update') || c.includes("'issue' 'update'"))).toBe(false);
  });

  test('no refs → does not even resolve the user', () => {
    const r = selfAssignLinkedIssuesGitlab('no refs here', '/w', undefined);
    expect(r).toEqual({ assigned: [], warnings: [] });
    expect(execCalls().length).toBe(0);
  });
});

describe('withLinkedAssign', () => {
  test('adds linked_issues_assigned only when non-empty', () => {
    expect(withLinkedAssign({ a: 1 }, { assigned: [3, 4], warnings: [] })).toEqual({
      a: 1,
      linked_issues_assigned: [3, 4],
    });
  });

  test('adds warnings only when non-empty', () => {
    expect(withLinkedAssign({ a: 1 }, { assigned: [], warnings: ['boom'] })).toEqual({
      a: 1,
      linked_issue_assign_warnings: ['boom'],
    });
  });

  test('adds nothing when both empty', () => {
    expect(withLinkedAssign({ a: 1 }, { assigned: [], warnings: [] })).toEqual({ a: 1 });
  });
});
