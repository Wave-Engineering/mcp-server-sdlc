import { describe, test, expect, beforeEach } from 'bun:test';
import {
  installChildProcessMock,
  setExecMock,
  resetExecMock,
} from '../test-support/mock-child-process.ts';
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

installChildProcessMock();

const { fetchCiTrustSignalGitlab, fetchCiTrustSignalGitlabSync } = await import(
  './fetch-ci-trust-signal-gitlab.ts'
);

beforeEach(() => {
  resetExecMock();
  setExecMock(() => '');
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
    setExecMock(stubProjectRepo(true));
    const signal = fetchCiTrustSignalGitlabSync();
    expect(signal.level).toBe('pre_merge_authoritative');
    expect(signal.reason).toContain('merge trains');
  });

  test('merge_trains_enabled=false → post_merge_required', () => {
    setExecMock(stubProjectRepo(false));
    const signal = fetchCiTrustSignalGitlabSync();
    expect(signal.level).toBe('post_merge_required');
    expect(signal.reason).toContain('without merge trains');
  });

  test('merge_trains_enabled missing → post_merge_required', () => {
    setExecMock((cmd: string) => {
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
    });
    const signal = fetchCiTrustSignalGitlabSync();
    expect(signal.level).toBe('post_merge_required');
  });
});

describe('fetchCiTrustSignalGitlab — AdapterResult wrapper', () => {
  test('returns ok:true wrapping CiTrustSignal on success', async () => {
    setExecMock(stubProjectRepo(true));
    const result = await fetchCiTrustSignalGitlab({});
    expectOk(result);
    expect(result.data.level).toBe('pre_merge_authoritative');
  });

  test('returns ok:false with code on subprocess failure', async () => {
    // Realistic failure: origin resolves, then the glab API call fails. (The
    // earlier stub threw for EVERY command, so the source died at slug parsing
    // and never surfaced the glab error — a bug the mock-leak was masking, #455.)
    setExecMock((cmd) => {
      if (cmd.includes('git remote get-url')) {
        return 'https://gitlab.com/org/repo.git\n';
      }
      throw new Error('glab: 401 unauthorized');
    });
    const result = await fetchCiTrustSignalGitlab({});
    expectErr(result);
    expect(result.code).toBe('glab_ci_trust_failed');
    expect(result.error).toContain('unauthorized');
  });
});
