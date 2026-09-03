import { describe, test, expect, beforeEach } from 'bun:test';
import {
  installChildProcessMock,
  onExec,
  resetExecMock,
  execCalls,
} from '../test-support/mock-child-process.ts';
import type { AdapterResult, BranchCreateResponse } from './types.ts';

// Subprocess-boundary tests for the GitLab branch_create adapter (#579 + #580):
// self-assign via the additive `+user` form, and the native work-item Status
// flip To do → In progress. Detailed Status logic lives in
// gitlab-work-item-status.test.ts; here we assert the WIRING (status_transition
// and warnings threaded onto the response).

installChildProcessMock();

const { branchCreateGitlab } = await import('./branch-create-gitlab.ts');

function expectOk(
  r: AdapterResult<BranchCreateResponse>,
): asserts r is { ok: true; data: BranchCreateResponse } {
  if (!('ok' in r) || !r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
}

function stubCleanCheckout(base: string, branch: string): void {
  onExec('git status --porcelain', '');
  onExec(`git checkout ${base}`, '');
  onExec(`git pull --ff-only origin ${base}`, '');
  onExec(`git checkout -b ${branch}`, '');
  onExec('git rev-parse HEAD', 'abc123def456abc123def456abc123def456abcd\n');
}

/** Mock the native-Status read (returns the given status) + write (success). */
function stubStatusFlow(name: string, category: string): void {
  onExec(
    'workItems(iid',
    JSON.stringify({
      data: {
        project: {
          workItems: {
            nodes: [
              {
                id: 'gid://gitlab/WorkItem/1',
                widgets: [{ type: 'STATUS', status: { id: 'gid://x/1', name, category } }],
              },
            ],
          },
        },
      },
    }),
  );
  onExec('workItemUpdate', JSON.stringify({ data: { workItemUpdate: { errors: [] } } }));
}

beforeEach(() => {
  resetExecMock();
});

describe('branchCreateGitlab', () => {
  test('happy path: self-assigns (+user) AND flips Status To do → In progress', async () => {
    stubCleanCheckout('main', 'feature/580-foo');
    onExec('glab api /user', JSON.stringify({ username: 'bj-bots' }));
    onExec('glab issue update 580', 'ok\n');
    stubStatusFlow('To do', 'to_do');

    const r = await branchCreateGitlab({ branch: 'feature/580-foo', base: 'main', repo: 'grp/proj', cwd: '/w' });
    expectOk(r);
    expect(r.data.issue_assigned).toBe(580);
    expect(r.data.status_transition).toEqual({ from: 'To do', to: 'In progress' });
    expect(r.data.warnings).toBeUndefined();
    const upd = execCalls().find((c) => c.includes("'glab' 'issue' 'update' '580'")) ?? '';
    expect(upd).toContain("'--assignee' '+bj-bots'");
  });

  test('null self-resolution is non-fatal — branch created, one warning, Status still flips', async () => {
    stubCleanCheckout('main', 'fix/580-bar');
    // No `glab api /user` → self-assign null; Status flow still mocked to succeed.
    stubStatusFlow('To do', 'to_do');

    const r = await branchCreateGitlab({ branch: 'fix/580-bar', base: 'main', repo: 'grp/proj', cwd: '/w' });
    expectOk(r);
    expect(r.data.issue_assigned).toBeUndefined();
    expect(r.data.status_transition).toEqual({ from: 'To do', to: 'In progress' });
    expect(r.data.warnings?.length).toBe(1); // the self-assign warning only
  });

  test('Status skip (project lacks the widget) surfaces as a warning, no status_transition', async () => {
    stubCleanCheckout('main', 'fix/580-baz');
    onExec('glab api /user', JSON.stringify({ username: 'bj-bots' }));
    onExec('glab issue update 580', 'ok\n');
    // Read returns a work item with NO STATUS widget → mechanism absent.
    onExec(
      'workItems(iid',
      JSON.stringify({ data: { project: { workItems: { nodes: [{ id: 'gid://gitlab/WorkItem/1', widgets: [] }] } } } }),
    );

    const r = await branchCreateGitlab({ branch: 'fix/580-baz', base: 'main', repo: 'grp/proj', cwd: '/w' });
    expectOk(r);
    expect(r.data.status_transition).toBeUndefined();
    expect(r.data.warnings?.some((w) => w.includes('does not expose the native work-item Status'))).toBe(true);
  });
});
