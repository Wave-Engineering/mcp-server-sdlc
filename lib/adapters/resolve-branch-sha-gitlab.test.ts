import { describe, test, expect } from 'bun:test';
import { resolveBranchShaGitlab } from './resolve-branch-sha-gitlab.ts';

// R-03 typed-asymmetry test: GitLab doesn't need branch→SHA resolution
// (pipelines attach to branch names directly). The adapter must return a
// `platform_unsupported` signal — not a fake-success null, not a throw.

describe('resolveBranchShaGitlab — R-03 typed asymmetry', () => {
  test('returns platform_unsupported with a descriptive hint', async () => {
    const result = await resolveBranchShaGitlab({ branch: 'main' });
    if (!('platform_unsupported' in result)) {
      throw new Error(
        `expected platform_unsupported, got ${JSON.stringify(result)}`,
      );
    }
    expect(result.platform_unsupported).toBe(true);
    // The hint must describe WHY — callers need the signal, not a generic stub.
    expect(result.hint.toLowerCase()).toContain('gitlab');
    expect(result.hint.toLowerCase()).toContain('branch');
  });

  test('platform_unsupported regardless of args', async () => {
    const result = await resolveBranchShaGitlab({
      branch: 'feature/1-demo',
      repo: 'org/repo',
    });
    expect('platform_unsupported' in result).toBe(true);
  });
});
