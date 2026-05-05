import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { AdapterResult, WorkItemUpdateResponse } from './types.ts';

// Subprocess-boundary tests for the GitHub work_item_update adapter (#287).
// Argv strictness per `lesson_origin_ops_pitfalls.md`: gh takes `--repo`
// (long flag) and `--body <string>` inline; NOT glab's `-R` / `--description`.

interface ThrowableError extends Error {
  stderr?: string;
  stdout?: string;
  status?: number;
}

let execRegistry: Array<{ match: string; respond: string | (() => string) }> = [];
let execCalls: string[] = [];

function unquote(cmd: string): string {
  return cmd.replace(/'([^']*)'/g, '$1');
}

const mockExecSync = mock((cmd: string, _opts?: unknown) => {
  execCalls.push(cmd);
  const flat = unquote(cmd);
  if (
    flat.includes('gh issue edit') &&
    (/\s-R\s/.test(flat) || /--description/.test(flat))
  ) {
    const err = new Error('FAIL: gh issue edit invoked with glab-style flags') as ThrowableError;
    err.status = 127;
    throw err;
  }
  for (const { match, respond } of execRegistry) {
    if (cmd.includes(match) || flat.includes(match)) {
      return typeof respond === 'function' ? respond() : respond;
    }
  }
  const err = new Error(`Unexpected exec: ${cmd}`) as ThrowableError;
  err.stderr = `Unexpected exec: ${cmd}`;
  err.status = 127;
  throw err;
});

mock.module('child_process', () => ({ execSync: mockExecSync }));

const { workItemUpdateGithub } = await import('./work-item-update-github.ts');

function on(match: string, respond: string | (() => string)): void {
  execRegistry.push({ match, respond });
}

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

function findCall(needle: string): string {
  return execCalls.find((c) => c.includes(needle) || unquote(c).includes(needle)) ?? '';
}

beforeEach(() => {
  execRegistry = [];
  execCalls = [];
});

describe('workItemUpdateGithub — subprocess boundary', () => {
  // ---- title-only patch ----

  test("title-only patch: emits gh issue edit with --title and no --body", async () => {
    on('gh issue edit', 'https://github.com/org/repo/issues/42\n');

    const result = await workItemUpdateGithub({
      issue_ref: '#42',
      patch: { title: 'New title' },
    });
    expectOk(result);

    const call = findCall('gh issue edit');
    expect(call).toContain("'gh' 'issue' 'edit' '42'");
    expect(call).toContain("'--title' 'New title'");
    expect(call).not.toContain('--body');
    expect(result.data.number).toBe(42);
    expect(result.data.dry_run).toBe(false);
    expect(result.data.updated_fields).toEqual(['title']);
  });

  // ---- body-only patch (no pre-fetch needed) ----

  test('body-only patch: emits --body and skips the pre-fetch view', async () => {
    on('gh issue edit', 'https://github.com/org/repo/issues/42\n');

    const result = await workItemUpdateGithub({
      issue_ref: '#42',
      patch: { body: 'completely new body' },
    });
    expectOk(result);

    expect(execCalls.some((c) => unquote(c).includes('gh issue view'))).toBe(false);
    const call = findCall('gh issue edit');
    expect(call).toContain("'--body' 'completely new body'");
    expect(result.data.updated_fields).toEqual(['body']);
  });

  // ---- repo flag forwarding ----

  test('--repo forwarded for cross-repo update', async () => {
    on('gh issue edit', 'https://github.com/foo/bar/issues/9\n');

    await workItemUpdateGithub({
      issue_ref: '#9',
      patch: { title: 'X' },
      repo: 'foo/bar',
    });

    const call = findCall('gh issue edit');
    expect(call).toContain("'--repo' 'foo/bar'");
  });

  test('rejects malformed repo slug with typed error', async () => {
    const result = await workItemUpdateGithub({
      issue_ref: '#1',
      patch: { title: 'x' },
      repo: 'not a slug',
    });
    expectErr(result);
    expect(result.code).toBe('invalid_repo_slug');
  });

  // ---- issue_ref parsing ----

  test('parses owner/repo#N issue_ref', async () => {
    on('gh issue edit', 'https://github.com/org/repo/issues/123\n');

    const result = await workItemUpdateGithub({
      issue_ref: 'org/repo#123',
      patch: { title: 'X' },
    });
    expectOk(result);
    expect(result.data.number).toBe(123);
  });

  test('rejects unparseable issue_ref', async () => {
    const result = await workItemUpdateGithub({
      issue_ref: 'not-an-issue',
      patch: { title: 'x' },
    });
    expectErr(result);
    expect(result.code).toBe('invalid_issue_ref');
  });

  // ---- labels: replacement-via-add/remove diff ----

  test('labels patch: pre-fetches current labels and emits add/remove diff', async () => {
    on(
      'gh issue view',
      JSON.stringify({
        number: 7,
        url: 'https://github.com/org/repo/issues/7',
        body: '## Summary\nbody\n',
        labels: [{ name: 'old-keep' }, { name: 'old-drop' }],
        assignees: [],
      }),
    );
    on('gh issue edit', 'https://github.com/org/repo/issues/7\n');

    const result = await workItemUpdateGithub({
      issue_ref: '#7',
      patch: { labels: ['old-keep', 'new-add'] },
    });
    expectOk(result);

    const call = findCall('gh issue edit');
    expect(call).toContain("'--add-label' 'new-add'");
    expect(call).toContain("'--remove-label' 'old-drop'");
    expect(call).not.toContain("'--add-label' 'old-keep'");
  });

  // ---- assignees: same diff shape ----

  test('assignees patch: emits add/remove diff against current set', async () => {
    on(
      'gh issue view',
      JSON.stringify({
        number: 11,
        url: 'https://github.com/org/repo/issues/11',
        body: '',
        labels: [],
        assignees: [{ login: 'alice' }, { login: 'bob' }],
      }),
    );
    on('gh issue edit', 'https://github.com/org/repo/issues/11\n');

    await workItemUpdateGithub({
      issue_ref: '#11',
      patch: { assignees: ['alice', 'carol'] },
    });

    const call = findCall('gh issue edit');
    expect(call).toContain("'--add-assignee' 'carol'");
    expect(call).toContain("'--remove-assignee' 'bob'");
    expect(call).not.toContain("'--add-assignee' 'alice'");
  });

  // ---- milestone (GitHub only) ----

  test('milestone patch: emits --milestone flag', async () => {
    on('gh issue edit', 'https://github.com/org/repo/issues/3\n');

    await workItemUpdateGithub({
      issue_ref: '#3',
      patch: { milestone: 'v1.0' },
    });

    const call = findCall('gh issue edit');
    expect(call).toContain("'--milestone' 'v1.0'");
  });

  // ---- body_section: read-modify-write ----

  test('body_section patch: pre-fetches body, splices section, sends full body', async () => {
    const originalBody = [
      '## Summary',
      'short summary',
      '',
      '## Dependencies',
      '- old dep',
      '',
      '## Acceptance Criteria',
      '- [ ] AC',
    ].join('\n');

    on(
      'gh issue view',
      JSON.stringify({
        number: 5,
        url: 'https://github.com/org/repo/issues/5',
        body: originalBody,
        labels: [],
        assignees: [],
      }),
    );
    on('gh issue edit', 'https://github.com/org/repo/issues/5\n');

    const result = await workItemUpdateGithub({
      issue_ref: '#5',
      patch: { body_section: { heading: 'Dependencies', content: '- new dep' } },
    });
    expectOk(result);
    expect(result.data.updated_fields).toEqual(['body_section']);
    expect(result.data.resolved_body).toContain('## Dependencies');
    expect(result.data.resolved_body).toContain('- new dep');
    expect(result.data.resolved_body).not.toContain('- old dep');
    // AC: section patching preserves other H2 sections unmodified
    expect(result.data.resolved_body).toContain('## Summary');
    expect(result.data.resolved_body).toContain('short summary');
    expect(result.data.resolved_body).toContain('## Acceptance Criteria');
    expect(result.data.resolved_body).toContain('- [ ] AC');

    const call = findCall('gh issue edit');
    expect(call).toContain('--body');
  });

  test('body_section: missing section returns typed error, no edit invoked', async () => {
    on(
      'gh issue view',
      JSON.stringify({
        number: 5,
        url: 'https://github.com/org/repo/issues/5',
        body: '## Summary\nx\n',
        labels: [],
        assignees: [],
      }),
    );

    const result = await workItemUpdateGithub({
      issue_ref: '#5',
      patch: { body_section: { heading: 'Dependencies', content: '- x' } },
    });
    expectErr(result);
    expect(result.code).toBe('section_splice_failed');
    expect(execCalls.some((c) => unquote(c).includes('gh issue edit'))).toBe(false);
  });

  // ---- dry_run: no side effect ----

  test('dry_run:true returns proposed changes without invoking gh issue edit', async () => {
    const result = await workItemUpdateGithub({
      issue_ref: '#42',
      patch: { title: 'Preview' },
      dry_run: true,
    });
    expectOk(result);
    expect(result.data.dry_run).toBe(true);
    expect(result.data.updated_fields).toEqual(['title']);
    expect(execCalls.some((c) => unquote(c).includes('gh issue edit'))).toBe(false);
  });

  test('dry_run:true with body_section pre-fetches and returns resolved_body', async () => {
    on(
      'gh issue view',
      JSON.stringify({
        number: 9,
        url: 'https://github.com/org/repo/issues/9',
        body: '## A\nold\n',
        labels: [],
        assignees: [],
      }),
    );

    const result = await workItemUpdateGithub({
      issue_ref: '#9',
      patch: { body_section: { heading: 'A', content: 'new' } },
      dry_run: true,
    });
    expectOk(result);
    expect(result.data.dry_run).toBe(true);
    expect(result.data.resolved_body).toContain('new');
    expect(execCalls.some((c) => unquote(c).includes('gh issue edit'))).toBe(false);
  });

  // ---- patch validation ----

  test('rejects empty patch', async () => {
    const result = await workItemUpdateGithub({ issue_ref: '#1', patch: {} });
    expectErr(result);
    expect(result.code).toBe('empty_patch');
  });

  test('rejects body + body_section together', async () => {
    const result = await workItemUpdateGithub({
      issue_ref: '#1',
      patch: { body: 'x', body_section: { heading: 'A', content: 'y' } },
    });
    expectErr(result);
    expect(result.code).toBe('patch_conflict');
  });

  // ---- error surface ----

  test('returns AdapterResult.error on gh issue edit failure', async () => {
    on('gh issue edit', () => {
      const err = new Error('not authenticated') as ThrowableError;
      err.stderr = 'gh: not authenticated';
      err.status = 1;
      throw err;
    });

    const result = await workItemUpdateGithub({ issue_ref: '#1', patch: { title: 'x' } });
    expectErr(result);
    expect(result.code).toBe('gh_issue_edit_failed');
  });

  test('returns AdapterResult.error on gh issue view failure during pre-fetch', async () => {
    on('gh issue view', () => {
      const err = new Error('not found') as ThrowableError;
      err.stderr = 'no such issue';
      err.status = 1;
      throw err;
    });

    const result = await workItemUpdateGithub({
      issue_ref: '#1',
      patch: { labels: ['x'] },
    });
    expectErr(result);
    expect(result.code).toBe('gh_issue_view_failed');
  });
});
