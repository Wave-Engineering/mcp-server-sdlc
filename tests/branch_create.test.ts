import { describe, test, expect, beforeEach } from 'bun:test';
import {
  installChildProcessMock,
  onExec,
  resetExecMock,
  execCalls,
} from '../lib/test-support/mock-child-process.ts';

// Handler integration tests for branch_create (#579): the full stack
// (handler → getAdapter → platform adapter → core → git) through the shared
// child_process mock. Platform is selected by the `git remote get-url origin`
// stub, mirroring tests/pr_create.test.ts.

installChildProcessMock();

const { default: handler } = await import('../handlers/branch_create.ts');

function parseResult(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

function stubCleanCheckout(base: string, branch: string): void {
  onExec('git status --porcelain', '');
  onExec(`git checkout ${base}`, '');
  onExec(`git pull --ff-only origin ${base}`, '');
  onExec(`git checkout -b ${branch}`, '');
  onExec('git rev-parse HEAD', 'abc123def456abc123def456abc123def456abcd\n');
}

beforeEach(() => {
  resetExecMock();
});

describe('branch_create handler', () => {
  test('github happy path — creates branch, self-assigns, returns normalized data', async () => {
    onExec('git remote get-url origin', 'git@github.com:org/repo.git\n');
    stubCleanCheckout('main', 'feature/579-foo');
    onExec('gh issue edit 579', 'ok\n');

    const result = await handler.execute({ branch: 'feature/579-foo', base: 'main' });
    const data = parseResult(result);
    expect(data.ok).toBe(true);
    expect(data.issue_number).toBe(579);
    expect(data.issue_assigned).toBe(579);
  });

  test('gitlab happy path — additive +user self-assign', async () => {
    onExec('git remote get-url origin', 'git@gitlab.com:org/repo.git\n');
    stubCleanCheckout('main', 'fix/579-bar');
    onExec('glab api /user', JSON.stringify({ username: 'bj-bots' }));
    onExec('glab issue update 579', 'ok\n');

    const result = await handler.execute({ branch: 'fix/579-bar', base: 'main' });
    const data = parseResult(result);
    expect(data.ok).toBe(true);
    expect(data.issue_assigned).toBe(579);
    expect(execCalls().some((c) => c.includes("'--assignee' '+bj-bots'"))).toBe(true);
  });

  test('rejects an empty branch (schema) without dispatching', async () => {
    const result = await handler.execute({ branch: '' });
    const data = parseResult(result);
    expect(data.ok).toBe(false);
  });

  test('surfaces a dirty-tree refusal as a typed error', async () => {
    onExec('git remote get-url origin', 'git@github.com:org/repo.git\n');
    onExec('git status --porcelain', ' M lib/x.ts\n');

    const result = await handler.execute({ branch: 'fix/579-x', base: 'main' });
    const data = parseResult(result);
    expect(data.ok).toBe(false);
    expect(data.code).toBe('dirty_working_tree');
  });
});
