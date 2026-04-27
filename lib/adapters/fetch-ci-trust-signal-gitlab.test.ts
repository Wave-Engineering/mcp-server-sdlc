import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { AdapterResult, CiTrustSignal } from './types.ts';

// Subprocess-boundary tests for the GitLab fetchCiTrustSignal adapter
// (Story 2.24, #318 — FINAL Phase 2 migration). Each test file installs its
// OWN `mock.module` BEFORE the dynamic import (56-file convention).

function expectOk(
  r: AdapterResult<CiTrustSignal>,
): asserts r is { ok: true; data: CiTrustSignal } {
  if (!('ok' in r) || !r.ok) {
    throw new Error(`expected ok result, got ${JSON.stringify(r)}`);
  }
}

function expectErr(
  r: AdapterResult<CiTrustSignal>,
): asserts r is { ok: false; error: string; code: string } {
  if (!('ok' in r) || r.ok) {
    throw new Error(`expected error result, got ${JSON.stringify(r)}`);
  }
}

let execCalls: string[] = [];
let execMockFn: (cmd: string) => string = () => '';
const mockExecSync = mock((cmd: string) => {
  execCalls.push(cmd);
  return execMockFn(cmd);
});
mock.module('child_process', () => ({ execSync: mockExecSync }));

const { fetchCiTrustSignalGitlab, fetchCiTrustSignalGitlabSync } = await import(
  './fetch-ci-trust-signal-gitlab.ts'
);

beforeEach(() => {
  execCalls = [];
  execMockFn = () => '';
  mockExecSync.mockClear();
});

function stubProjectRepo(merge_trains_enabled: boolean): (cmd: string) => string {
  return (cmd: string) => {
    if (cmd.includes('git remote get-url')) {
      return 'https://gitlab.com/org/repo.git\n';
    }
    if (cmd.includes('glab api projects/org%2Frepo')) {
      return JSON.stringify({
        id: 1,
        name: 'repo',
        path: 'repo',
        path_with_namespace: 'org/repo',
        web_url: 'https://gitlab.com/org/repo',
        merge_pipelines_enabled: true,
        merge_trains_enabled,
      });
    }
    return '{}';
  };
}

describe('fetchCiTrustSignalGitlabSync — subprocess boundary', () => {
  test('merge_trains_enabled=true → pre_merge_authoritative', () => {
    execMockFn = stubProjectRepo(true);
    const signal = fetchCiTrustSignalGitlabSync();
    expect(signal.level).toBe('pre_merge_authoritative');
    expect(signal.reason).toContain('merge trains');
  });

  test('merge_trains_enabled=false → post_merge_required', () => {
    execMockFn = stubProjectRepo(false);
    const signal = fetchCiTrustSignalGitlabSync();
    expect(signal.level).toBe('post_merge_required');
    expect(signal.reason).toContain('without merge trains');
  });

  test('merge_trains_enabled missing → post_merge_required', () => {
    execMockFn = (cmd: string) => {
      if (cmd.includes('git remote get-url')) {
        return 'https://gitlab.com/org/repo.git\n';
      }
      if (cmd.includes('glab api projects/org%2Frepo')) {
        return JSON.stringify({
          id: 1,
          name: 'repo',
          path: 'repo',
          path_with_namespace: 'org/repo',
          web_url: 'https://gitlab.com/org/repo',
        });
      }
      return '{}';
    };
    const signal = fetchCiTrustSignalGitlabSync();
    expect(signal.level).toBe('post_merge_required');
  });
});

describe('fetchCiTrustSignalGitlab — AdapterResult wrapper', () => {
  test('returns ok:true wrapping CiTrustSignal on success', async () => {
    execMockFn = stubProjectRepo(true);
    const result = await fetchCiTrustSignalGitlab({});
    expectOk(result);
    expect(result.data.level).toBe('pre_merge_authoritative');
  });

  test('returns ok:false with code on subprocess failure', async () => {
    execMockFn = () => {
      throw new Error('glab: 401 unauthorized');
    };
    const result = await fetchCiTrustSignalGitlab({});
    expectErr(result);
    expect(result.code).toBe('glab_ci_trust_failed');
    expect(result.error).toContain('unauthorized');
  });
});
