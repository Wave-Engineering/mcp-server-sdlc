import { describe, test, expect, beforeEach } from 'bun:test';
import {
  installChildProcessMock,
  onExec,
  resetExecMock,
  execCalls,
} from '../test-support/mock-child-process.ts';

// Subprocess-boundary tests for the precheck gate's reads (#592). The contract
// (claudecode-workflow docs/precheck-status.md) is that every read FAILS
// CLOSED: an exit code, an error body, unparseable output or an unexpected
// shape is `ok: false`, never a soft `none`. Only a well-formed answer with no
// `precheck` entry is `none`.

installChildProcessMock();

const { precheckStatusGithub } = await import('./precheck-status-github.ts');
const { precheckStatusGitlab } = await import('./precheck-status-gitlab.ts');
const { remoteBranchShaGithub } = await import('./remote-branch-sha-github.ts');
const { remoteBranchShaGitlab } = await import('./remote-branch-sha-gitlab.ts');
const { prPrecheckInfoGithub } = await import('./pr-precheck-info-github.ts');
const { prPrecheckInfoGitlab } = await import('./pr-precheck-info-gitlab.ts');
const { stripDraftPrefix } = await import('./pr-ready-gitlab.ts');

const SHA = 'c'.repeat(40);

function failWith(match: string): void {
  onExec(match, () => {
    const err = new Error('boom') as Error & { status?: number; stderr?: string };
    err.status = 1;
    err.stderr = 'HTTP 500';
    throw err;
  });
}

beforeEach(() => resetExecMock());

describe('precheckStatus — github', () => {
  test('reads the latest precheck context from the combined status', async () => {
    onExec('/status?per_page=100', JSON.stringify({ statuses: [{ context: 'ci', state: 'failure' }, { context: 'precheck', state: 'success' }] }));
    expect(await precheckStatusGithub({ sha: SHA, repo: 'o/r' })).toEqual({ ok: true, data: { state: 'success' } });
    expect(execCalls()[0]).toContain(`repos/o/r/commits/${SHA}/status`);
  });

  test('no precheck entry is none; error is failure', async () => {
    onExec('/status?per_page=100', JSON.stringify({ statuses: [{ context: 'ci', state: 'success' }] }));
    expect(await precheckStatusGithub({ sha: SHA })).toEqual({ ok: true, data: { state: 'none' } });
    resetExecMock();
    onExec('/status?per_page=100', JSON.stringify({ statuses: [{ context: 'precheck', state: 'error' }] }));
    expect(await precheckStatusGithub({ sha: SHA })).toEqual({ ok: true, data: { state: 'failure' } });
  });

  test('fails closed: exit code, unparseable output, no statuses list, bad sha', async () => {
    failWith('/status?per_page=100');
    expect((await precheckStatusGithub({ sha: SHA })) as { ok: boolean }).toMatchObject({ ok: false });
    resetExecMock();
    onExec('/status?per_page=100', 'not json');
    expect((await precheckStatusGithub({ sha: SHA })) as { ok: boolean }).toMatchObject({ ok: false });
    resetExecMock();
    onExec('/status?per_page=100', JSON.stringify({ message: 'Not Found' }));
    expect((await precheckStatusGithub({ sha: SHA })) as { ok: boolean }).toMatchObject({ ok: false });
    expect((await precheckStatusGithub({ sha: 'abc' })) as { code: string }).toMatchObject({ code: 'invalid_sha' });
  });
});

describe('precheckStatus — gitlab', () => {
  test('the newest precheck status wins (highest id)', async () => {
    onExec(
      '/statuses?name=precheck',
      JSON.stringify([
        { id: 3, name: 'precheck', status: 'failed' },
        { id: 9, name: 'precheck', status: 'success' },
        { id: 5, name: 'precheck', status: 'running' },
      ]),
    );
    expect(await precheckStatusGitlab({ sha: SHA, repo: 'g/sub/p' })).toEqual({ ok: true, data: { state: 'success' } });
    expect(execCalls()[0]).toContain('projects/g%2Fsub%2Fp/repository/commits/');
  });

  test('empty is none; running is pending; canceled is failure', async () => {
    onExec('/statuses?name=precheck', '[]');
    expect(await precheckStatusGitlab({ sha: SHA })).toEqual({ ok: true, data: { state: 'none' } });
    resetExecMock();
    onExec('/statuses?name=precheck', JSON.stringify([{ id: 1, name: 'precheck', status: 'running' }]));
    expect(await precheckStatusGitlab({ sha: SHA })).toEqual({ ok: true, data: { state: 'pending' } });
    resetExecMock();
    onExec('/statuses?name=precheck', JSON.stringify([{ id: 1, name: 'precheck', status: 'canceled' }]));
    expect(await precheckStatusGitlab({ sha: SHA })).toEqual({ ok: true, data: { state: 'failure' } });
  });

  test('fails closed: exit code, an error body on exit 0, a non-list', async () => {
    failWith('/statuses?name=precheck');
    expect((await precheckStatusGitlab({ sha: SHA })) as { ok: boolean }).toMatchObject({ ok: false });
    resetExecMock();
    onExec('/statuses?name=precheck', JSON.stringify({ message: '404 Project Not Found' }));
    expect((await precheckStatusGitlab({ sha: SHA })) as { ok: boolean }).toMatchObject({ ok: false });
    resetExecMock();
    onExec('/statuses?name=precheck', JSON.stringify({ id: 1, name: 'precheck', status: 'success' }));
    expect((await precheckStatusGitlab({ sha: SHA })) as { ok: boolean }).toMatchObject({ ok: false });
  });
});

describe('remoteBranchSha', () => {
  test('github: the exact-match singular ref endpoint', async () => {
    onExec('/git/ref/heads/', JSON.stringify({ object: { sha: SHA } }));
    expect(await remoteBranchShaGithub({ branch: 'feature/1-x', repo: 'o/r' })).toEqual({ ok: true, data: { sha: SHA } });
    expect(execCalls()[0]).toContain('repos/o/r/git/ref/heads/feature/1-x');
  });

  test('github: an unpushed branch or an array (prefix) answer fails closed', async () => {
    failWith('/git/ref/heads/');
    expect((await remoteBranchShaGithub({ branch: 'feature/1-x' })) as { ok: boolean }).toMatchObject({ ok: false });
    resetExecMock();
    onExec('/git/ref/heads/', JSON.stringify([{ object: { sha: SHA } }]));
    expect((await remoteBranchShaGithub({ branch: 'feature/1-x' })) as { ok: boolean }).toMatchObject({ ok: false });
  });

  test('gitlab: the branch is URL-encoded; an error body fails closed', async () => {
    onExec('/repository/branches/', JSON.stringify({ name: 'feature/1-x', commit: { id: SHA } }));
    expect(await remoteBranchShaGitlab({ branch: 'feature/1-x' })).toEqual({ ok: true, data: { sha: SHA } });
    expect(execCalls()[0]).toContain('branches/feature%2F1-x');
    resetExecMock();
    onExec('/repository/branches/', JSON.stringify({ message: '404 Branch Not Found' }));
    expect((await remoteBranchShaGitlab({ branch: 'feature/1-x' })) as { ok: boolean }).toMatchObject({ ok: false });
  });
});

describe('prPrecheckInfo', () => {
  test('github: a view without headRefOid or isDraft fails closed', async () => {
    onExec('--json id,headRefOid', JSON.stringify({ id: 'X', headRefName: 'f', baseRefName: 'main', state: 'OPEN' }));
    expect((await prPrecheckInfoGithub({ number: 1 })) as { ok: boolean }).toMatchObject({ ok: false });
  });

  test('gitlab: an MR without a boolean draft never reads as ready', async () => {
    onExec('merge_requests/1', JSON.stringify({ iid: 1, sha: SHA, source_branch: 'f', target_branch: 'main', state: 'opened' }));
    expect((await prPrecheckInfoGitlab({ number: 1 })) as { ok: boolean }).toMatchObject({ ok: false });
  });

  test('gitlab: work_in_progress stands in for draft on an older GitLab', async () => {
    onExec(
      'merge_requests/1',
      JSON.stringify({ iid: 1, sha: SHA, source_branch: 'f', target_branch: 'main', state: 'opened', work_in_progress: true, description: 'd', title: 't' }),
    );
    const r = await prPrecheckInfoGitlab({ number: 1 });
    expect(r).toMatchObject({ ok: true, data: { draft: true, head_sha: SHA, body: 'd' } });
  });
});

describe('stripDraftPrefix', () => {
  test('strips every leading draft prefix, case-insensitively, and nothing else', () => {
    expect(stripDraftPrefix('Draft: x')).toBe('x');
    expect(stripDraftPrefix('[Draft] (draft) DRAFT: x')).toBe('x');
    expect(stripDraftPrefix('x Draft: y')).toBe('x Draft: y');
    expect(stripDraftPrefix('WIP: x')).toBe('WIP: x');
  });
});
