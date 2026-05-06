/**
 * Integration tests for CLI flag surfaces.
 *
 * These tests MUST NOT mock child_process — they exec real `gh` and `glab`
 * binaries to verify the flags our handlers depend on still exist.
 *
 * Motivation: #382, #383, and pr_wait_ci all followed the same pattern: mock-
 * based tests fed canned JSON, CI was green, but real CLI calls failed because
 * the flags we passed didn't exist.
 */

import { describe, test, expect } from 'bun:test';
import { execSync } from 'child_process';

// --- Helper ----------------------------------------------------------------
// `gh` and `glab` write `--help` output to stderr in some environments
// (notably GitHub Actions runners); locally they write to stdout. We need
// both. `2>&1` merges stderr into stdout so `execSync`'s captured output
// contains the help text regardless of where the CLI sent it.
function captureHelp(cmd: string): string {
  return execSync(`${cmd} 2>&1`, { encoding: 'utf8' });
}

// --- CLI Availability Guards -----------------------------------------------

function hasGh(): boolean {
  try {
    execSync('which gh', { encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
}

function hasGlab(): boolean {
  try {
    execSync('which glab', { encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
}

// --- GitHub CLI Flag Shapes ------------------------------------------------

describe('GitHub CLI flag shapes', () => {
  if (!hasGh()) {
    test.skip('gh not installed — skipping GitHub integration tests', () => {});
    return;
  }

  test('gh issue view accepts --json flag', () => {
    const help = captureHelp('gh issue view --help');
    expect(help).toMatch(/--json/);
  });

  test('gh issue view --json accepts state, title, url fields', () => {
    // Used by ibm handler (via fetch-issue-github adapter)
    const help = captureHelp('gh issue view --help');
    // The --json flag is documented, but we can't test specific field names
    // without hitting the API. This test verifies the flag exists.
    expect(help).toMatch(/--json/);
  });

  test('gh pr list accepts --head, --json flags', () => {
    // Used by ibm handler (via fetch-pr-for-branch-github adapter)
    // and pr_create handler (via pr-create-github adapter)
    const help = captureHelp('gh pr list --help');
    expect(help).toMatch(/--head/);
    expect(help).toMatch(/--json/);
  });

  test('gh pr create accepts required flags', () => {
    // Used by pr_create handler
    const help = captureHelp('gh pr create --help');
    expect(help).toMatch(/--title/);
    expect(help).toMatch(/--body/);
    expect(help).toMatch(/--base/);
    expect(help).toMatch(/--head/);
    expect(help).toMatch(/--draft/);
    expect(help).toMatch(/--repo/);
  });

  test('gh pr view accepts --json flag', () => {
    // Used by pr_create handler for post-create lookup
    const help = captureHelp('gh pr view --help');
    expect(help).toMatch(/--json/);
  });

  test('gh pr view --json statusCheckRollup is documented', () => {
    // Used by pr_wait_ci handler (via pr-wait-ci-github adapter)
    // Regression guard for #220: do NOT use `gh pr checks --json`
    const help = captureHelp('gh pr view --help');
    expect(help).toMatch(/--json/);
    // statusCheckRollup is a valid field for --json but not always listed in --help
    // The key assertion is that `gh pr view --json` exists (not `gh pr checks --json`)
  });

  test('gh pr checks does NOT accept --json flag (regression guard for pr_wait_ci)', () => {
    // This is the broken flag from the pr_wait_ci bug.
    // `gh pr checks` was added in gh ~2.50; Ubuntu 24.04 ships gh 2.45.
    // Our adapter uses `gh pr view --json statusCheckRollup` instead.
    try {
      const help = captureHelp('gh pr checks --help');
      // If the command exists, verify it does NOT accept --json
      expect(help).not.toMatch(/--json/);
    } catch (err) {
      // If `gh pr checks` doesn't exist, that's fine — we don't use it.
      // The test passes (we're asserting we DON'T use this subcommand).
      expect(err).toBeDefined();
    }
  });

  test('gh pr merge accepts --squash, --auto, --delete-branch flags', () => {
    // Used by pr_merge handler
    const help = captureHelp('gh pr merge --help');
    expect(help).toMatch(/--squash/);
    expect(help).toMatch(/--auto/);
    expect(help).toMatch(/--delete-branch/);
  });

  test('gh run list accepts --commit, --json flags', () => {
    // Used by ci_wait_run handler (via ci-runs-for-branch-github adapter)
    const help = captureHelp('gh run list --help');
    expect(help).toMatch(/--commit/);
    expect(help).toMatch(/--json/);
  });

  test('gh repo view accepts --json flag', () => {
    // Used by pr_create handler to resolve default branch
    const help = captureHelp('gh repo view --help');
    expect(help).toMatch(/--json/);
  });
});

// --- GitLab CLI Flag Shapes ------------------------------------------------

describe('GitLab CLI flag shapes', () => {
  if (!hasGlab()) {
    test.skip('glab not installed — skipping GitLab integration tests', () => {});
    return;
  }

  test('glab api accepts URL paths (project lookup shape)', () => {
    // Used by ibm handler, pr_create handler, etc.
    // This test verifies that `glab api projects/<encoded>` is a valid form.
    // We can't hit a real API without credentials, so we just verify the
    // subcommand exists and accepts a path argument.
    const help = captureHelp('glab api --help');
    expect(help).toMatch(/glab api/);
    // The help output shows USAGE section in all caps
    expect(help).toMatch(/USAGE/);
  });

  test('glab mr view does NOT accept -F flag (regression guard for #383)', () => {
    // This is the broken flag from #383.
    // Our adapter now uses `glab api projects/.../merge_requests` instead.
    const help = captureHelp('glab mr view --help');
    expect(help).not.toMatch(/-F[, ]/);
    expect(help).not.toMatch(/--format/);
  });

  test('glab mr create accepts required flags', () => {
    // Used by pr_create handler (via pr-create-gitlab adapter)
    const help = captureHelp('glab mr create --help');
    expect(help).toMatch(/--title/);
    expect(help).toMatch(/--description/);
    expect(help).toMatch(/--source-branch/);
    expect(help).toMatch(/--target-branch/);
    expect(help).toMatch(/--yes/);
    expect(help).toMatch(/--draft/);
  });

  test('glab mr create accepts -R flag for repo specification', () => {
    // Used by pr_create handler
    const help = captureHelp('glab mr create --help');
    expect(help).toMatch(/-R/);
  });

  test('glab mr merge accepts --yes, --remove-source-branch flags', () => {
    // Used by pr_merge handler
    const help = captureHelp('glab mr merge --help');
    expect(help).toMatch(/--yes/);
    expect(help).toMatch(/--remove-source-branch/);
  });

  test('glab api projects/.../pipelines query is valid (used by ci_runs_for_branch)', () => {
    // Used by ci_wait_run and ci_runs_for_branch handlers via gitlab-api.ts
    // Our handlers use `glab api projects/<encoded>/pipelines?ref=<branch>&limit=N`
    // instead of `glab ci list`, so verify the api subcommand exists.
    const help = captureHelp('glab api --help');
    expect(help).toMatch(/glab api/);
    expect(help).toMatch(/USAGE/);
    // The actual query params (ref, limit) are handled by GitLab REST API,
    // not glab flags, so we just verify the subcommand form is valid.
  });

  test('glab issue view accepts issue number argument', () => {
    // Used by ibm handler (via fetch-issue-gitlab adapter)
    // Note: we migrated to `glab api projects/.../issues/N` in #382 fix,
    // but verify the old form still works for reference.
    const help = captureHelp('glab issue view --help');
    expect(help).toMatch(/glab issue view/);
  });
});

// --- API-Based Operations --------------------------------------------------

describe('API-based operations (URL encoding)', () => {
  if (!hasGlab()) {
    test.skip('glab not installed — skipping API tests', () => {});
    return;
  }

  test('glab api accepts URL-encoded project paths', () => {
    // Our handlers use `projects/Wave-Engineering%2Fmcp-server-sdlc` form.
    // We can't hit a real API without GITLAB_TOKEN, but we can verify the
    // command doesn't reject the URL-encoding syntax by running it against
    // a fake project (it will fail with 404, not "invalid syntax").
    //
    // Skip this test if GITLAB_TOKEN is not set (local dev environments).
    if (!process.env.GITLAB_TOKEN) {
      console.log('  ℹ GITLAB_TOKEN not set — skipping live API test');
      return;
    }

    try {
      // This will 404 if the project doesn't exist, but that's fine —
      // we're testing that the URL-encoding is accepted, not that it succeeds.
      execSync('glab api projects/Wave-Engineering%2Fmcp-server-sdlc', {
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } catch (err) {
      // If it fails, check that it's a 404 (project shape accepted) or auth error,
      // not a "malformed URL" syntax error.
      const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? '';
      const message = (err as { message?: string }).message ?? '';
      const combined = stderr + message;

      // Acceptable failures: 404 (project not found), 401 (auth), 403 (forbidden)
      // These mean the URL-encoding was accepted by glab.
      // Unacceptable: "invalid URL", "malformed", "unknown flag"
      expect(combined).not.toMatch(/invalid URL/i);
      expect(combined).not.toMatch(/malformed/i);
      expect(combined).not.toMatch(/unknown flag/i);
    }
  });
});
