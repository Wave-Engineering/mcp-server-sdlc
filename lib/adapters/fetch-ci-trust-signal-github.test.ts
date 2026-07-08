import { describe, test, expect, beforeEach } from 'bun:test';
import type { AdapterResult, CiTrustSignal } from './types.ts';
import {
  installChildProcessMock,
  setExecMock,
  resetExecMock,
  execCalls,
} from '../test-support/mock-child-process.ts';

// Subprocess-boundary tests for the GitHub fetchCiTrustSignal adapter
// (Story 2.24, #318 — FINAL Phase 2 migration hybrid sub-call). Follows the
// 56-file convention: install own `mock.module` BEFORE the dynamic import.

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

const { fetchCiTrustSignalGithub, fetchCiTrustSignalGithubSync } = await import(
  './fetch-ci-trust-signal-github.ts'
);

beforeEach(() => {
  resetExecMock();
  setExecMock(() => '');
});

describe('fetchCiTrustSignalGithubSync — subprocess boundary', () => {
  test('merge_queue ruleset → pre_merge_authoritative', () => {
    setExecMock((cmd: string) => {
      if (cmd.includes('/rulesets') && !cmd.match(/rulesets\/\d+/)) {
        return JSON.stringify([{ id: 7, enforcement: 'active' }]);
      }
      if (cmd.includes('/rulesets/7')) {
        return JSON.stringify({ rules: [{ type: 'merge_queue' }] });
      }
      return '{}';
    });
    const signal = fetchCiTrustSignalGithubSync('org/repo');
    expect(signal.level).toBe('pre_merge_authoritative');
    expect(signal.reason).toContain('merge queue');
  });

  test('falls through to branch protection when no merge_queue rule', () => {
    setExecMock((cmd: string) => {
      if (cmd.includes('/rulesets') && !cmd.match(/rulesets\/\d+/)) {
        return JSON.stringify([{ id: 1, enforcement: 'active' }]);
      }
      if (cmd.includes('/rulesets/1')) {
        return JSON.stringify({ rules: [{ type: 'other_rule' }] });
      }
      if (cmd.includes('defaultBranchRef')) return 'main';
      if (cmd.includes('/branches/main/protection')) {
        return JSON.stringify({ required_status_checks: { strict: true } });
      }
      return '{}';
    });
    const signal = fetchCiTrustSignalGithubSync('org/repo');
    expect(signal.level).toBe('pre_merge_authoritative');
    expect(signal.reason).toContain('strict');
  });

  test('probes the LIVE default branch protection, not a hardcoded main (#472)', () => {
    let protectionCmd = '';
    setExecMock((cmd: string) => {
      if (cmd.includes('/rulesets') && !cmd.match(/rulesets\/\d+/)) {
        return JSON.stringify([]);
      }
      if (cmd.includes('defaultBranchRef')) return 'release/1.0.0';
      if (cmd.includes('/protection')) {
        protectionCmd = cmd;
        return JSON.stringify({ required_status_checks: { strict: true } });
      }
      return '{}';
    });
    const signal = fetchCiTrustSignalGithubSync('org/repo');
    expect(signal.level).toBe('pre_merge_authoritative');
    // The protection probe targets the resolved default, NOT `main`.
    expect(protectionCmd).toContain('branches/release/1.0.0/protection');
    expect(protectionCmd).not.toContain('branches/main/protection');
    expect(signal.reason).toContain('release/1.0.0');
  });

  test('branch protection without strict → post_merge_required', () => {
    setExecMock((cmd: string) => {
      if (cmd.includes('/rulesets') && !cmd.match(/rulesets\/\d+/)) {
        return JSON.stringify([]);
      }
      if (cmd.includes('defaultBranchRef')) return 'main';
      if (cmd.includes('/branches/main/protection')) {
        return JSON.stringify({ required_status_checks: { strict: false } });
      }
      return '{}';
    });
    const signal = fetchCiTrustSignalGithubSync('org/repo');
    expect(signal.level).toBe('post_merge_required');
  });

  test('missing required_status_checks → post_merge_required', () => {
    setExecMock((cmd: string) => {
      if (cmd.includes('/rulesets') && !cmd.match(/rulesets\/\d+/)) {
        return JSON.stringify([]);
      }
      if (cmd.includes('defaultBranchRef')) return 'main';
      if (cmd.includes('/branches/main/protection')) {
        return JSON.stringify({});
      }
      return '{}';
    });
    const signal = fetchCiTrustSignalGithubSync('org/repo');
    expect(signal.level).toBe('post_merge_required');
  });

  test('rulesets fetch fails → falls through to branch protection', () => {
    setExecMock((cmd: string) => {
      if (cmd.includes('/rulesets') && !cmd.match(/rulesets\/\d+/)) {
        throw new Error('gh api: 403');
      }
      if (cmd.includes('defaultBranchRef')) return 'main';
      if (cmd.includes('/branches/main/protection')) {
        return JSON.stringify({ required_status_checks: { strict: true } });
      }
      return '{}';
    });
    const signal = fetchCiTrustSignalGithubSync('org/repo');
    expect(signal.level).toBe('pre_merge_authoritative');
  });

  test('individual ruleset detail fetch failure does not abort scan', () => {
    setExecMock((cmd: string) => {
      if (cmd.includes('/rulesets') && !cmd.match(/rulesets\/\d+/)) {
        return JSON.stringify([
          { id: 1, enforcement: 'active' },
          { id: 2, enforcement: 'active' },
        ]);
      }
      if (cmd.includes('/rulesets/1')) throw new Error('boom');
      if (cmd.includes('/rulesets/2')) {
        return JSON.stringify({ rules: [{ type: 'merge_queue' }] });
      }
      return '{}';
    });
    const signal = fetchCiTrustSignalGithubSync('org/repo');
    expect(signal.level).toBe('pre_merge_authoritative');
  });

  test('rejects missing repo slug (no exec)', () => {
    expect(() => fetchCiTrustSignalGithubSync(undefined)).toThrow(
      /repo slug is required/,
    );
    expect(execCalls().length).toBe(0);
  });

  test('rejects malicious repo slug at adapter boundary (no exec)', () => {
    expect(() =>
      fetchCiTrustSignalGithubSync('org/repo; rm -rf /'),
    ).toThrow(/invalid repo slug/);
    expect(execCalls().length).toBe(0);
  });
});

describe('fetchCiTrustSignalGithub — AdapterResult wrapper', () => {
  test('returns ok:true wrapping CiTrustSignal on success', async () => {
    setExecMock((cmd: string) => {
      if (cmd.includes('/rulesets') && !cmd.match(/rulesets\/\d+/)) {
        return JSON.stringify([]);
      }
      if (cmd.includes('defaultBranchRef')) return 'main';
      if (cmd.includes('/branches/main/protection')) {
        return JSON.stringify({ required_status_checks: { strict: true } });
      }
      return '{}';
    });
    const result = await fetchCiTrustSignalGithub({ repo: 'org/repo' });
    expectOk(result);
    expect(result.data.level).toBe('pre_merge_authoritative');
  });

  test('returns ok:false with code on branch-protection subprocess failure', async () => {
    setExecMock((cmd: string) => {
      if (cmd.includes('/rulesets') && !cmd.match(/rulesets\/\d+/)) {
        return JSON.stringify([]);
      }
      throw new Error('gh api: not authenticated');
    });
    const result = await fetchCiTrustSignalGithub({ repo: 'org/repo' });
    expectErr(result);
    expect(result.code).toBe('gh_ci_trust_failed');
    expect(result.error).toContain('not authenticated');
  });

  test('returns ok:false on invalid repo slug (no exec)', async () => {
    const result = await fetchCiTrustSignalGithub({ repo: 'bad; rm' });
    expectErr(result);
    expect(result.error).toMatch(/invalid repo slug/);
    expect(execCalls().length).toBe(0);
  });

  test('returns ok:false when repo slug omitted', async () => {
    const result = await fetchCiTrustSignalGithub({});
    expectErr(result);
    expect(result.error).toMatch(/repo slug is required/);
  });
});
