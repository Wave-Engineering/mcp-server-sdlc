import { describe, test, expect, beforeEach } from 'bun:test';
import {
  installChildProcessMock,
  onExec,
  resetExecMock,
  execCalls,
} from '../test-support/mock-child-process.ts';

// Unit tests for the GitLab native work-item Status transition (#580):
// mechanism detection, the coupling-aware decision tree (skip done/canceled,
// no-op in_progress), name-based write, and the non-fatal warning paths.

installChildProcessMock();

const { markWorkItemInProgressGitlab } = await import('./gitlab-work-item-status.ts');

function readResponse(name: string | null, category: string | null, hasWidget = true): string {
  const widgets = hasWidget
    ? [{ type: 'STATUS', status: name ? { id: 'gid://x/1', name, category } : null }]
    : [];
  return JSON.stringify({
    data: { project: { workItems: { nodes: [{ id: 'gid://gitlab/WorkItem/42', widgets }] } } },
  });
}

beforeEach(() => {
  resetExecMock();
});

describe('markWorkItemInProgressGitlab', () => {
  test('to_do → writes name "In progress" against the read work item id, reports the transition', () => {
    onExec('workItems(iid', readResponse('To do', 'to_do'));
    onExec('workItemUpdate', JSON.stringify({ data: { workItemUpdate: { errors: [] } } }));

    const r = markWorkItemInProgressGitlab(42, '/w', 'grp/proj');
    expect(r.status_transition).toEqual({ from: 'To do', to: 'In progress' });
    expect(r.warning).toBeUndefined();
    const write = execCalls().find((c) => c.includes('workItemUpdate')) ?? '';
    expect(write).toContain('name=In progress');
    expect(write).toContain('id=gid://gitlab/WorkItem/42');
  });

  test('already in_progress → idempotent no-op (no write, no warning)', () => {
    onExec('workItems(iid', readResponse('In progress', 'in_progress'));
    const r = markWorkItemInProgressGitlab(42, '/w', 'grp/proj');
    expect(r).toEqual({});
    expect(execCalls().some((c) => c.includes('workItemUpdate'))).toBe(false);
  });

  test('done → warns and does NOT write (avoids reopening a closed item)', () => {
    onExec('workItems(iid', readResponse('Done', 'done'));
    const r = markWorkItemInProgressGitlab(42, '/w', 'grp/proj');
    expect(r.status_transition).toBeUndefined();
    expect(r.warning).toContain('not transitioning');
    expect(execCalls().some((c) => c.includes('workItemUpdate'))).toBe(false);
  });

  // ALLOWLIST fail-safe (regression for the blocklist bug): GitLab spells the
  // cancelled category with two Ls, and enums may arrive uppercase. Neither may
  // fall through to a write — an un-recognized category must be SKIPPED.
  test('two-L uppercase CANCELLED → skipped, never written', () => {
    onExec('workItems(iid', readResponse("Won't do", 'CANCELLED'));
    const r = markWorkItemInProgressGitlab(42, '/w', 'grp/proj');
    expect(r.status_transition).toBeUndefined();
    expect(r.warning).toContain('not transitioning');
    expect(execCalls().some((c) => c.includes('workItemUpdate'))).toBe(false);
  });

  test('one-L lowercase canceled → skipped, never written', () => {
    onExec('workItems(iid', readResponse("Won't do", 'canceled'));
    const r = markWorkItemInProgressGitlab(42, '/w', 'grp/proj');
    expect(r.status_transition).toBeUndefined();
    expect(execCalls().some((c) => c.includes('workItemUpdate'))).toBe(false);
  });

  test('an unknown/future category → skipped, never written', () => {
    onExec('workItems(iid', readResponse('Blocked', 'some_future_category'));
    const r = markWorkItemInProgressGitlab(42, '/w', 'grp/proj');
    expect(r.status_transition).toBeUndefined();
    expect(execCalls().some((c) => c.includes('workItemUpdate'))).toBe(false);
  });

  test('case-insensitive: uppercase TO_DO still writes (advance is not spelling-fragile)', () => {
    onExec('workItems(iid', readResponse('To do', 'TO_DO'));
    onExec('workItemUpdate', JSON.stringify({ data: { workItemUpdate: { errors: [] } } }));
    const r = markWorkItemInProgressGitlab(42, '/w', 'grp/proj');
    expect(r.status_transition).toEqual({ from: 'To do', to: 'In progress' });
  });

  test('no STATUS widget → mechanism-absent warning, no label fallback, no write', () => {
    onExec('workItems(iid', readResponse(null, null, false));
    const r = markWorkItemInProgressGitlab(42, '/w', 'grp/proj');
    expect(r.warning).toContain('does not expose the native work-item Status');
    expect(execCalls().some((c) => c.includes('workItemUpdate'))).toBe(false);
  });

  test('read failure (empty/error) → warning, no write', () => {
    onExec('workItems(iid', ''); // empty stdout → read error
    const r = markWorkItemInProgressGitlab(42, '/w', 'grp/proj');
    expect(r.warning).toContain('could not read work-item Status');
  });

  test('write failure (mutation errors[]) → warning, no transition', () => {
    onExec('workItems(iid', readResponse('To do', 'to_do'));
    onExec('workItemUpdate', JSON.stringify({ data: { workItemUpdate: { errors: ['nope'] } } }));
    const r = markWorkItemInProgressGitlab(42, '/w', 'grp/proj');
    expect(r.status_transition).toBeUndefined();
    expect(r.warning).toContain('failed to set work-item Status');
  });

  test('resolves the project full path from cwd when no repo given', () => {
    onExec('projects/:id', JSON.stringify({ path_with_namespace: 'grp/sub/proj' }));
    onExec('workItems(iid', readResponse('To do', 'to_do'));
    onExec('workItemUpdate', JSON.stringify({ data: { workItemUpdate: { errors: [] } } }));

    const r = markWorkItemInProgressGitlab(42, '/w', undefined);
    expect(r.status_transition).toEqual({ from: 'To do', to: 'In progress' });
    // The read query carried the resolved full path.
    const read = execCalls().find((c) => c.includes('workItems(iid')) ?? '';
    expect(read).toContain('fp=grp/sub/proj');
  });

  test('unresolvable project path (no repo, projects/:id fails) → warning', () => {
    // No projects/:id stub → unmatched → throws → resolveProjectFullPath returns null.
    const r = markWorkItemInProgressGitlab(42, '/w', undefined);
    expect(r.warning).toContain('could not resolve GitLab project path');
    expect(execCalls().some((c) => c.includes('workItems(iid'))).toBe(false);
  });
});
