import { describe, test, expect, beforeEach } from 'bun:test';
import {
  installChildProcessMock,
  onExec,
  resetExecMock,
  execCalls,
} from '../test-support/mock-child-process.ts';
import type {
  AdapterResult,
  ResolveBranchShaResponse,
} from './types.ts';

// Subprocess-boundary tests for the GitLab resolveBranchSha adapter (R-15).
// Story 2.22 (#316) upgraded this adapter from the permanent `platform_unsupported`
// stub (Story 2.19) to a real body lifted from the pre-migration `wave_init`
// handler so KAHUNA bootstrap can resolve the base-branch HEAD SHA on GitLab.

interface ThrowableError extends Error {
  stderr?: string;
  stdout?: string;
  status?: number;
}

function unquote(cmd: string): string {
  return cmd.replace(/'([^']*)'/g, '$1');
}

installChildProcessMock();

const { resolveBranchShaGitlab } = await import('./resolve-branch-sha-gitlab.ts');

function expectOk(
  r: AdapterResult<ResolveBranchShaResponse | null>,
): asserts r is { ok: true; data: ResolveBranchShaResponse | null } {
  if (!('ok' in r) || !r.ok) {
    throw new Error(`expected ok result, got ${JSON.stringify(r)}`);
  }
}

function findCall(needle: string): string {
  return execCalls().find((c) => c.includes(needle) || unquote(c).includes(needle)) ?? '';
}

beforeEach(() => {
  resetExecMock();
});

describe('resolveBranchShaGitlab — subprocess boundary', () => {
  test('argv: glab api projects/<encoded>/repository/branches/<branch>', async () => {
    const sha = 'a'.repeat(40);
    onExec(
      'glab api projects/org%2Frepo/repository/branches/main',
      JSON.stringify({ commit: { id: sha } }),
    );

    const result = await resolveBranchShaGitlab({ branch: 'main', repo: 'org/repo' });
    expectOk(result);
    expect(result.data).toEqual({ sha });

    const call = findCall('glab api');
    expect(call).toContain('projects/org%2Frepo/repository/branches/main');
  });

  test('soft-fails to null when glab errors (mirrors GitHub contract)', async () => {
    onExec('glab api', () => {
      const err = new Error('glab: 404') as ThrowableError;
      err.stderr = 'glab: not found';
      err.status = 1;
      throw err;
    });

    const result = await resolveBranchShaGitlab({ branch: 'main', repo: 'org/repo' });
    expectOk(result);
    expect(result.data).toBeNull();
  });

  test('returns null when commit.id is missing or invalid', async () => {
    onExec('glab api', JSON.stringify({ commit: { id: 'not-a-sha' } }));

    const result = await resolveBranchShaGitlab({ branch: 'main', repo: 'org/repo' });
    expectOk(result);
    expect(result.data).toBeNull();
  });

  test('returns null when stdout is not valid JSON', async () => {
    onExec('glab api', 'not-json');

    const result = await resolveBranchShaGitlab({ branch: 'main', repo: 'org/repo' });
    expectOk(result);
    expect(result.data).toBeNull();
  });

  test('returns null when repo is omitted (no slug to target)', async () => {
    const result = await resolveBranchShaGitlab({ branch: 'main' });
    expectOk(result);
    expect(result.data).toBeNull();
    expect(execCalls().length).toBe(0);
  });

  test('rejects invalid branch characters', async () => {
    const result = await resolveBranchShaGitlab({
      branch: 'bad; rm -rf /',
      repo: 'org/repo',
    });
    expect('ok' in result && result.ok).toBe(false);
    expect((result as { code: string }).code).toBe('invalid_branch');
  });

  test('rejects invalid repo slug', async () => {
    const result = await resolveBranchShaGitlab({
      branch: 'main',
      repo: 'no-slash',
    });
    expect('ok' in result && result.ok).toBe(false);
    expect((result as { code: string }).code).toBe('invalid_repo');
  });

  test('URL-encodes branch names with slashes (feature/1-demo → feature%2F1-demo)', async () => {
    const sha = 'b'.repeat(40);
    onExec(
      'glab api projects/org%2Frepo/repository/branches/feature%2F1-demo',
      JSON.stringify({ commit: { id: sha } }),
    );

    const result = await resolveBranchShaGitlab({
      branch: 'feature/1-demo',
      repo: 'org/repo',
    });
    expectOk(result);
    expect(result.data).toEqual({ sha });

    const call = findCall('glab api');
    expect(call).toContain('branches/feature%2F1-demo');
    expect(call).not.toContain('branches/feature/1-demo');
  });

  test('URL-encodes multi-segment branches (release/0.0.1)', async () => {
    const sha = 'd'.repeat(40);
    onExec(
      'glab api projects/team%2Fproject%2Fsub%2Frepo/repository/branches/release%2F0.0.1',
      JSON.stringify({ commit: { id: sha } }),
    );

    const result = await resolveBranchShaGitlab({
      branch: 'release/0.0.1',
      repo: 'team/project/sub/repo',
    });
    expectOk(result);
    expect(result.data).toEqual({ sha });

    const call = findCall('glab api');
    expect(call).toContain('branches/release%2F0.0.1');
  });

  test('supports nested group slugs (org/sub/repo → org%2Fsub%2Frepo)', async () => {
    const sha = 'c'.repeat(40);
    onExec(
      'glab api projects/org%2Fsub%2Frepo/repository/branches/main',
      JSON.stringify({ commit: { id: sha } }),
    );

    const result = await resolveBranchShaGitlab({
      branch: 'main',
      repo: 'org/sub/repo',
    });
    expectOk(result);
    expect(result.data).toEqual({ sha });
  });
});
