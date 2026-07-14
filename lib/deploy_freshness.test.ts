import { describe, test, expect } from 'bun:test';
import {
  checkDeployFreshness,
  getBuildInfo,
  type CompareStatus,
  type FreshnessDeps,
} from './deploy_freshness.ts';

const SHA = 'a'.repeat(40);

function deps(over: Partial<FreshnessDeps> = {}): FreshnessDeps {
  return {
    fetchLatestReleaseTag: async () => 'v2.0.5',
    compareRefs: async () => 'ahead',
    ...over,
  };
}

describe('deploy-freshness (#447)', () => {
  // In the (uncompiled) test runtime the __BUILD_*__ defines are absent, so the
  // build reads as 'dev'. That is itself the "skip a dev build" path — assert it.
  test('a dev build (no embedded SHA) is skipped — never warns', async () => {
    expect(getBuildInfo().sha).toBe('dev');
    let compared = false;
    const r = await checkDeployFreshness(
      deps({ compareRefs: async () => { compared = true; return 'ahead'; } }),
    );
    expect(r).toBeNull();
    expect(compared).toBe(false); // short-circuits before any network call
  });

  // The remaining cases need a REAL 40-hex SHA. getBuildInfo() reads the injected
  // globals, so set them for the duration of the test.
  function withBuildSha<T>(sha: string, fn: () => T): T {
    (globalThis as Record<string, unknown>).__BUILD_SHA__ = sha;
    (globalThis as Record<string, unknown>).__BUILD_REF__ = 'v2.0.1';
    (globalThis as Record<string, unknown>).__BUILD_AT__ = '2026-05-14T02:39:00Z';
    try {
      return fn();
    } finally {
      delete (globalThis as Record<string, unknown>).__BUILD_SHA__;
      delete (globalThis as Record<string, unknown>).__BUILD_REF__;
      delete (globalThis as Record<string, unknown>).__BUILD_AT__;
    }
  }

  test('binary BEHIND the latest release → warns, naming both and the remedy', async () => {
    const r = await withBuildSha(SHA, () =>
      checkDeployFreshness(deps({ compareRefs: async (base, head) => {
        expect(base).toBe(SHA);   // base = binary
        expect(head).toBe('v2.0.5'); // head = latest release
        return 'ahead';           // release is ahead → binary behind
      } })),
    );
    expect(r).not.toBeNull();
    expect(r!.binary_sha).toBe(SHA);
    expect(r!.latest_release).toBe('v2.0.5');
  });

  test('binary IDENTICAL to the latest release → no warning', async () => {
    const r = await withBuildSha(SHA, () =>
      checkDeployFreshness(deps({ compareRefs: async () => 'identical' })),
    );
    expect(r).toBeNull();
  });

  test('binary NEWER than the latest release (a dev build past the tag) → no warning', async () => {
    // base=binary is ahead of head=release → status 'behind' → do not warn.
    const r = await withBuildSha(SHA, () =>
      checkDeployFreshness(deps({ compareRefs: async () => 'behind' })),
    );
    expect(r).toBeNull();
  });

  test('DIVERGED (built off a side branch) → no warning', async () => {
    const r = await withBuildSha(SHA, () =>
      checkDeployFreshness(deps({ compareRefs: async () => 'diverged' })),
    );
    expect(r).toBeNull();
  });

  test('offline / no releases (tag lookup fails) → silent, no compare attempted', async () => {
    let compared = false;
    const r = await withBuildSha(SHA, () =>
      checkDeployFreshness(deps({
        fetchLatestReleaseTag: async () => null,
        compareRefs: async () => { compared = true; return 'ahead'; },
      })),
    );
    expect(r).toBeNull();
    expect(compared).toBe(false);
  });

  test('compare call fails (network blip) → silent', async () => {
    const r = await withBuildSha(SHA, () =>
      checkDeployFreshness(deps({ compareRefs: async () => null })),
    );
    expect(r).toBeNull();
  });

  test('a THROWING dep never propagates — the check must not disrupt startup', async () => {
    const r = await withBuildSha(SHA, () =>
      checkDeployFreshness(deps({
        fetchLatestReleaseTag: async () => { throw new Error('boom'); },
      })),
    );
    expect(r).toBeNull(); // swallowed, not thrown
  });
});

describe('ghFreshnessDeps — the real IO boundary is non-throwing (#447)', () => {
  // The unit tests above inject fakes, so they never exercise the real subprocess
  // path — which is exactly where the "never disrupt the server" property lives.
  // Point PATH at nothing so `gh` cannot be found (ENOENT), and assert the real
  // deps resolve to null rather than throwing or hanging.
  test('a missing `gh` resolves to null, never throws', async () => {
    const { ghFreshnessDeps } = await import('./deploy_freshness_gh.ts');
    const savedPath = process.env.PATH;
    process.env.PATH = '/nonexistent-dir-for-freshness-test';
    try {
      const tag = await ghFreshnessDeps.fetchLatestReleaseTag();
      const cmp = await ghFreshnessDeps.compareRefs('a'.repeat(40), 'v1.0.0');
      expect(tag).toBeNull();
      expect(cmp).toBeNull();
    } finally {
      process.env.PATH = savedPath;
    }
  });
});
