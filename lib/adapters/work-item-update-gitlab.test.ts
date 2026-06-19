import { describe, test, expect, beforeEach } from 'bun:test';
import {
  onExec,
  execCalls,
  resetExecMock,
  installChildProcessMock,
} from '../test-support/mock-child-process.ts';
import type { AdapterResult, WorkItemUpdateResponse } from './types.ts';

// Subprocess-boundary tests for the GitLab work_item_update adapter (#287).
// Argv strictness per `lesson_origin_ops_pitfalls.md`: glab uses `-R`,
// `--description` (not `--body`), CSV labels — NOT GitHub-style flags.

interface ThrowableError extends Error {
  stderr?: string;
  stdout?: string;
  status?: number;
}

function unquote(cmd: string): string {
  return cmd.replace(/'([^']*)'/g, '$1');
}

installChildProcessMock();

const { workItemUpdateGitlab } = await import('./work-item-update-gitlab.ts');

function expectOk(
  r: AdapterResult<WorkItemUpdateResponse>,
): asserts r is { ok: true; data: WorkItemUpdateResponse } {
  if (!('ok' in r) || !r.ok) {
    throw new Error(`expected ok result, got ${JSON.stringify(r)}`);
  }
}

function expectErr(
  r: AdapterResult<WorkItemUpdateResponse>,
): asserts r is { ok: false; error: string; code: string } {
  if (!('ok' in r) || r.ok) {
    throw new Error(`expected error result, got ${JSON.stringify(r)}`);
  }
}

function expectUnsupported(
  r: AdapterResult<WorkItemUpdateResponse>,
): asserts r is { platform_unsupported: true; hint: string } {
  if (!('platform_unsupported' in r)) {
    throw new Error(`expected platform_unsupported, got ${JSON.stringify(r)}`);
  }
}

function findCall(needle: string): string {
  return execCalls().find((c) => c.includes(needle) || unquote(c).includes(needle)) ?? '';
}

beforeEach(() => {
  resetExecMock();
});

describe('workItemUpdateGitlab — subprocess boundary', () => {
  test('title-only patch emits glab issue update --title', async () => {
    onExec('glab issue update', 'https://gitlab.com/org/repo/-/issues/42\n');

    const result = await workItemUpdateGitlab({
      issue_ref: '#42',
      patch: { title: 'New title' },
    });
    expectOk(result);

    const call = findCall('glab issue update');
    expect(call).toContain("'glab' 'issue' 'update' '42'");
    expect(call).toContain("'--title' 'New title'");
    expect(result.data.dry_run).toBe(false);
  });

  test('body-only patch emits --description (NOT --body)', async () => {
    onExec('glab issue update', 'https://gitlab.com/org/repo/-/issues/42\n');

    await workItemUpdateGitlab({ issue_ref: '#42', patch: { body: 'x' } });

    const call = findCall('glab issue update');
    expect(call).toContain("'--description' 'x'");
    expect(call).not.toContain("'--body' 'x'");
  });

  test('-R forwarded for cross-repo update (NOT --repo)', async () => {
    onExec('glab issue update', 'https://gitlab.com/foo/bar/-/issues/9\n');

    await workItemUpdateGitlab({
      issue_ref: '#9',
      patch: { title: 'X' },
      repo: 'foo/bar',
    });

    const call = findCall('glab issue update');
    expect(call).toContain("'-R' 'foo/bar'");
    expect(call).not.toContain('--repo');
  });

  test('labels patch emits CSV --label / --unlabel diff', async () => {
    onExec(
      'glab issue view',
      JSON.stringify({
        iid: 7,
        web_url: 'https://gitlab.com/org/repo/-/issues/7',
        description: '',
        labels: ['old-keep', 'old-drop'],
        assignees: [],
      }),
    );
    onExec('glab issue update', 'https://gitlab.com/org/repo/-/issues/7\n');

    await workItemUpdateGitlab({
      issue_ref: '#7',
      patch: { labels: ['old-keep', 'new-add'] },
    });

    const call = findCall('glab issue update');
    expect(call).toContain("'--label' 'new-add'");
    expect(call).toContain("'--unlabel' 'old-drop'");
  });

  test('assignees patch emits --assignee / --unassign diff', async () => {
    onExec(
      'glab issue view',
      JSON.stringify({
        iid: 11,
        web_url: 'https://gitlab.com/org/repo/-/issues/11',
        description: '',
        labels: [],
        assignees: [{ username: 'alice' }, { username: 'bob' }],
      }),
    );
    onExec('glab issue update', 'https://gitlab.com/org/repo/-/issues/11\n');

    await workItemUpdateGitlab({
      issue_ref: '#11',
      patch: { assignees: ['alice', 'carol'] },
    });

    const call = findCall('glab issue update');
    expect(call).toContain("'--assignee' 'carol'");
    expect(call).toContain("'--unassign' 'bob'");
  });

  // ---- #287: cross-platform asymmetry ----

  test('milestone returns platform_unsupported (#287 — GitLab milestone resolution out of scope)', async () => {
    const result = await workItemUpdateGitlab({
      issue_ref: '#1',
      patch: { milestone: 'v1.0' },
    });
    expectUnsupported(result);
    expect(result.hint.toLowerCase()).toContain('milestone');
    // No glab subprocess should have been attempted.
    expect(execCalls().length).toBe(0);
  });

  // ---- body_section: read-modify-write ----

  test('body_section: pre-fetches description, splices, sends full description', async () => {
    const original = [
      '## Summary',
      'short',
      '',
      '## Dependencies',
      '- old',
      '',
      '## Acceptance Criteria',
      '- [ ] AC',
    ].join('\n');

    onExec(
      'glab issue view',
      JSON.stringify({
        iid: 5,
        web_url: 'https://gitlab.com/org/repo/-/issues/5',
        description: original,
        labels: [],
        assignees: [],
      }),
    );
    onExec('glab issue update', 'https://gitlab.com/org/repo/-/issues/5\n');

    const result = await workItemUpdateGitlab({
      issue_ref: '#5',
      patch: { body_section: { heading: 'Dependencies', content: '- new' } },
    });
    expectOk(result);
    expect(result.data.resolved_body).toContain('- new');
    expect(result.data.resolved_body).not.toContain('- old');
    expect(result.data.resolved_body).toContain('## Acceptance Criteria');

    const call = findCall('glab issue update');
    expect(call).toContain('--description');
  });

  test('body_section missing returns typed error', async () => {
    onExec(
      'glab issue view',
      JSON.stringify({
        iid: 5,
        web_url: 'https://gitlab.com/org/repo/-/issues/5',
        description: '## Summary\nx\n',
        labels: [],
        assignees: [],
      }),
    );

    const result = await workItemUpdateGitlab({
      issue_ref: '#5',
      patch: { body_section: { heading: 'NotPresent', content: 'y' } },
    });
    expectErr(result);
    expect(result.code).toBe('section_splice_failed');
  });

  // ---- dry_run ----

  test('dry_run:true skips glab issue update', async () => {
    const result = await workItemUpdateGitlab({
      issue_ref: '#42',
      patch: { title: 'Preview' },
      dry_run: true,
    });
    expectOk(result);
    expect(result.data.dry_run).toBe(true);
    expect(execCalls().some((c) => unquote(c).includes('glab issue update'))).toBe(false);
  });

  // ---- validation ----

  test('rejects unparseable issue_ref', async () => {
    const result = await workItemUpdateGitlab({
      issue_ref: 'not-an-issue',
      patch: { title: 'x' },
    });
    expectErr(result);
    expect(result.code).toBe('invalid_issue_ref');
  });

  test('rejects empty patch', async () => {
    const result = await workItemUpdateGitlab({ issue_ref: '#1', patch: {} });
    expectErr(result);
    expect(result.code).toBe('empty_patch');
  });

  test('rejects body + body_section together', async () => {
    const result = await workItemUpdateGitlab({
      issue_ref: '#1',
      patch: { body: 'x', body_section: { heading: 'A', content: 'y' } },
    });
    expectErr(result);
    expect(result.code).toBe('patch_conflict');
  });

  // ---- error surface ----

  test('returns AdapterResult.error on glab issue update failure', async () => {
    onExec('glab issue update', () => {
      const err = new Error('forbidden') as ThrowableError;
      err.stderr = 'glab: 403';
      err.status = 1;
      throw err;
    });

    const result = await workItemUpdateGitlab({ issue_ref: '#1', patch: { title: 'x' } });
    expectErr(result);
    expect(result.code).toBe('glab_issue_update_failed');
  });
});
