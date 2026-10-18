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
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { findGlabOutputFlag, stripTsComments } from './glab-source-guard.js';

// --- Helper ----------------------------------------------------------------
// `gh` and `glab` write `--help` output to different streams depending on
// environment (locally → stdout; GitHub Actions runners → stream we can't
// reliably capture). We can't use `spawnSync` here because other test files
// (pr-merge-github.test.ts) mock `child_process` and the mock leaks across
// bun's shared test-runner module space, removing all exports except
// `execSync`. So: use execSync with shell redirect, and if the result is
// empty, treat it as "help capture unavailable in this environment" and
// skip the assertion (return null). Tests handle null by short-circuiting.
function captureHelp(cmd: string): string | null {
  try {
    const result = execSync(`${cmd} 2>&1`, {
      encoding: 'utf8',
      env: { ...process.env, GH_PAGER: '', PAGER: 'cat', GLAB_PAGER: '' },
    });
    return result.length > 0 ? result : null;
  } catch (err) {
    // Some CLIs exit non-zero on --help in certain environments; the help
    // text usually still landed in stdout/stderr.
    const stderr = (err as { stderr?: Buffer | string }).stderr;
    const stdout = (err as { stdout?: Buffer | string }).stdout;
    const out = (stdout?.toString() ?? '') + (stderr?.toString() ?? '');
    return out.length > 0 ? out : null;
  }
}

// #496: distinguish "did not run" from "ran and passed". A silent skip that
// leaves the test green is indistinguishable from a real pass — the exact
// "a guard that skips silently cannot tell you it did not run" failure class as
// #491/#492/#494. So a skip must be OBSERVABLE, and in CI it must FAIL:
// locally, a missing `gh`/`glab` (or an environment that can't capture help)
// is a convenience skip; in CI it is a configuration error — the whole point of
// this suite is catching a CLI that rejects a flag we depend on, and it cannot
// do that while quietly no-op'ing.
function isCI(): boolean {
  return process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
}

// matchOrSkip: assert the pattern matches. If help capture returned null
// (environment couldn't capture CLI help output) FAIL in CI — an unverifiable
// flag-shape guard there is a config error, not a pass — and emit an observable
// skip locally.
function matchOrSkip(help: string | null, pattern: RegExp): void {
  if (help === null) {
    if (isCI()) {
      throw new Error(
        `CLI help capture returned empty in CI — cannot verify flag ${String(pattern)}. ` +
          `A flag-shape check that cannot run in CI is a configuration error: a silent skip ` +
          `is indistinguishable from a check that ran and passed.`,
      );
    }
    console.log(`  ⚠ NOT RUN (skipped locally) — help capture empty; cannot verify ${String(pattern)}`);
    return;
  }
  expect(help).toMatch(pattern);
}

function notMatchOrSkip(help: string | null, pattern: RegExp): void {
  if (help === null) {
    if (isCI()) {
      throw new Error(
        `CLI help capture returned empty in CI — cannot verify absence of ${String(pattern)}. ` +
          `A flag-shape check that cannot run in CI is a configuration error: a silent skip ` +
          `is indistinguishable from a check that ran and passed.`,
      );
    }
    console.log(`  ⚠ NOT RUN (skipped locally) — help capture empty; cannot verify absence of ${String(pattern)}`);
    return;
  }
  expect(help).not.toMatch(pattern);
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
    // #496: gh ships on the default CI image (ubuntu-latest), so its absence
    // there is a configuration error rather than a convenience — fail loudly so
    // a guard that never ran is not reported as a pass. Locally it is a skip.
    if (isCI()) {
      test('gh must be installed in CI — GitHub flag-shape guards cannot run without it', () => {
        throw new Error(
          'gh is not installed in CI: GitHub flag-shape guards did NOT run. This is a ' +
            'configuration error, not a skip — a guard that cannot run cannot catch a broken flag.',
        );
      });
    } else {
      test.skip('gh not installed — GitHub flag-shape guards NOT RUN (local convenience skip)', () => {});
    }
    return;
  }

  test('gh issue view accepts --json flag', () => {
    const help = captureHelp('gh issue view --help');
    matchOrSkip(help, /--json/);
  });

  test('gh issue view --json accepts state, title, url fields', () => {
    // Used by ibm handler (via fetch-issue-github adapter)
    const help = captureHelp('gh issue view --help');
    // The --json flag is documented, but we can't test specific field names
    // without hitting the API. This test verifies the flag exists.
    matchOrSkip(help, /--json/);
  });

  test('gh pr list accepts --head, --json flags', () => {
    // Used by ibm handler (via fetch-pr-for-branch-github adapter)
    // and pr_create handler (via pr-create-github adapter)
    const help = captureHelp('gh pr list --help');
    matchOrSkip(help, /--head/);
    matchOrSkip(help, /--json/);
  });

  test('gh pr create accepts required flags', () => {
    // Used by pr_create handler
    const help = captureHelp('gh pr create --help');
    matchOrSkip(help, /--title/);
    matchOrSkip(help, /--body/);
    matchOrSkip(help, /--base/);
    matchOrSkip(help, /--head/);
    matchOrSkip(help, /--draft/);
    matchOrSkip(help, /--repo/);
  });

  test('gh pr view accepts --json flag', () => {
    // Used by pr_create handler for post-create lookup
    const help = captureHelp('gh pr view --help');
    matchOrSkip(help, /--json/);
  });

  test('gh pr view --json statusCheckRollup is documented', () => {
    // Used by pr_wait_ci handler (via pr-wait-ci-github adapter)
    // Regression guard for #220: do NOT use `gh pr checks --json`
    const help = captureHelp('gh pr view --help');
    matchOrSkip(help, /--json/);
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
      notMatchOrSkip(help, /--json/);
    } catch (err) {
      // If `gh pr checks` doesn't exist, that's fine — we don't use it.
      // The test passes (we're asserting we DON'T use this subcommand).
      expect(err).toBeDefined();
    }
  });

  test('gh pr merge accepts --squash, --auto, --delete-branch flags', () => {
    // Used by pr_merge handler
    const help = captureHelp('gh pr merge --help');
    matchOrSkip(help, /--squash/);
    matchOrSkip(help, /--auto/);
    matchOrSkip(help, /--delete-branch/);
  });

  test('gh pr merge accepts --merge and --rebase strategy flags (#474)', () => {
    // Used by pr_merge / pr_merge_wait via pr-merge-github when merge_method is
    // 'merge' or 'rebase'. Unit tests assert against a MOCKED argv string and
    // would stay green against a gh that rejects these flags, so verify the
    // real CLI accepts them.
    const help = captureHelp('gh pr merge --help');
    matchOrSkip(help, /--merge/);
    matchOrSkip(help, /--rebase/);
  });

  test('gh run list accepts --commit, --json flags', () => {
    // Used by ci_wait_run handler (via ci-runs-for-branch-github adapter)
    const help = captureHelp('gh run list --help');
    matchOrSkip(help, /--commit/);
    matchOrSkip(help, /--json/);
  });

  test('gh repo view accepts --json flag', () => {
    // Used by pr_create handler to resolve default branch
    const help = captureHelp('gh repo view --help');
    matchOrSkip(help, /--json/);
  });
});

// --- GitLab CLI Flag Shapes ------------------------------------------------

describe('GitLab CLI flag shapes', () => {
  if (!hasGlab()) {
    // #496: glab is NOT installed on the default CI image, so these flag-shape
    // guards do not run there today — a known gap recorded in
    // docs/adapters/README.md (§10, "CLI toolchain"). This skip is OBSERVABLE
    // (bun reports it as skipped, distinct from a pass) rather than a silent
    // green. To make the guard actually run in CI — the guard whose whole
    // purpose is catching a glab that rejects --sha/--auto-merge (#486) — the
    // CI workflow must install glab; see §10 for the recorded minimum version.
    test.skip(
      'glab not installed — GitLab flag-shape guards NOT RUN (see docs/adapters/README.md §10)',
      () => {},
    );
    return;
  }

  test('glab api accepts URL paths (project lookup shape)', () => {
    // Used by ibm handler, pr_create handler, etc.
    // This test verifies that `glab api projects/<encoded>` is a valid form.
    // We can't hit a real API without credentials, so we just verify the
    // subcommand exists and accepts a path argument.
    const help = captureHelp('glab api --help');
    matchOrSkip(help, /glab api/);
    // The help output shows USAGE section in all caps
    matchOrSkip(help, /USAGE/);
  });

  test('glab mr create accepts required flags', () => {
    // Used by pr_create handler (via pr-create-gitlab adapter)
    const help = captureHelp('glab mr create --help');
    matchOrSkip(help, /--title/);
    matchOrSkip(help, /--description/);
    matchOrSkip(help, /--source-branch/);
    matchOrSkip(help, /--target-branch/);
    matchOrSkip(help, /--yes/);
    matchOrSkip(help, /--draft/);
  });

  test('glab mr create accepts -R flag for repo specification', () => {
    // Used by pr_create handler
    const help = captureHelp('glab mr create --help');
    matchOrSkip(help, /-R/);
  });

  test('glab mr merge accepts --yes, --remove-source-branch flags', () => {
    // Used by pr_merge handler
    const help = captureHelp('glab mr merge --help');
    matchOrSkip(help, /--yes/);
    matchOrSkip(help, /--remove-source-branch/);
  });

  test('glab mr merge accepts --squash and --rebase strategy flags (#474)', () => {
    // Used by pr_merge / pr_merge_wait via pr-merge-gitlab when merge_method is
    // 'squash' or 'rebase' ('merge' uses glab's default = no flag). Unit tests
    // assert against a MOCKED argv string, so verify the real CLI accepts them.
    const help = captureHelp('glab mr merge --help');
    matchOrSkip(help, /--squash/);
    matchOrSkip(help, /--rebase/);
  });

  test('glab mr merge accepts --sha and --auto-merge flags (#486)', () => {
    // Used by pr_merge / pr_merge_wait via pr-merge-gitlab.
    //
    // These are load-bearing and cannot be covered by the unit suite, which
    // asserts against a MOCKED argv string and would stay green against a glab
    // that rejects the flags:
    //   --sha        GitLab's stale-head guard. Without it, namespaces with
    //                `require_sha_for_merge` (now the DEFAULT for new groups)
    //                reject the merge with 400.
    //   --auto-merge Passed explicitly as `--auto-merge=false` (pr_merge's
    //                deterministic attempt, and pr_merge_wait's own first
    //                attempt) or `--auto-merge=true` (pr_merge_wait's retry
    //                after a pipeline-gated refusal — #488). It is a
    //                relatively recent rename — older glab exposed this as
    //                `--when-pipeline-succeeds`. On a glab predating the
    //                rename, either explicit form is an UNKNOWN FLAG and
    //                every GitLab merge fails, which is worse than the bug
    //                #486 fixed.
    const help = captureHelp('glab mr merge --help');
    matchOrSkip(help, /--sha/);
    matchOrSkip(help, /--auto-merge/);
  });

  test('glab api projects/.../pipelines query is valid (used by ci_runs_for_branch)', () => {
    // Used by ci_wait_run and ci_runs_for_branch handlers via gitlab-api.ts
    // Our handlers use `glab api projects/<encoded>/pipelines?ref=<branch>&limit=N`
    // instead of `glab ci list`, so verify the api subcommand exists.
    const help = captureHelp('glab api --help');
    matchOrSkip(help, /glab api/);
    matchOrSkip(help, /USAGE/);
    // The actual query params (ref, limit) are handled by GitLab REST API,
    // not glab flags, so we just verify the subcommand form is valid.
  });

  test('glab issue view accepts issue number argument', () => {
    // Used by ibm handler (via fetch-issue-gitlab adapter)
    // Note: we migrated to `glab api projects/.../issues/N` in #382 fix,
    // but verify the old form still works for reference.
    const help = captureHelp('glab issue view --help');
    matchOrSkip(help, /glab issue view/);
  });
});

// --- API-Based Operations --------------------------------------------------

describe('API-based operations (URL encoding)', () => {
  if (!hasGlab()) {
    // #496: observable skip — see the GitLab flag-shapes block and
    // docs/adapters/README.md §10. Not a silent green.
    test.skip(
      'glab not installed — GitLab API-shape guards NOT RUN (see docs/adapters/README.md §10)',
      () => {},
    );
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

// Source-level guard: needs no glab, so it lives outside the hasGlab()-gated
// blocks above and runs in CI, where glab is not installed.
describe('GitLab adapter source', () => {
  test('no adapter asks a non-api glab subcommand for -F/--output/--format (regression guard for #383, #594)', () => {
    // #383: `glab mr view <head> -F json` did not exist in glab 1.36, so the MR
    // lookup failed in production; the adapters moved to `glab api
    // projects/.../merge_requests`. This guard used to assert glab's HELP
    // lacked -F, which tested glab, not us, and went red for every box once
    // glab 1.53 (apt, 2026-10-03) added `-F, --output` to `mr view`. Live-verified
    // under 1.53 that the adapters' real calls still work (#590). The invariant
    // that matters is ours: no code path depends on that flag, on any glab version.
    //
    //
    // #594 widened it from `mr view` to every subcommand except `api`. The same
    // dependency was live in `issue view` and `label list`: both gained `-F` in
    // glab 1.37.0 (read from glab's source at v1.36.0 and v1.37.0), one release
    // above the documented 1.36.0 floor, so those adapters failed there.
    //
    // Matched against each file's whole comment-stripped text, not line by line:
    // the adapters build argv as multi-line arrays (one token per line, or flags
    // on the next line, as in pr-create-gitlab.ts where #383 lived) and add
    // optional flags with .push(), so a per-line scan would miss the very
    // regression it guards. Comments are removed by a real stripper (see
    // glab-source-guard.ts), so a trailing `// glab mr view -F json` note is not
    // a hit (#594). Still invisible to a static scan: a subcommand held in a
    // variable (['glab', subcmd, ...]); that form needs a mock-level test.
    const offenders: string[] = [];
    const root = join(import.meta.dir, '..', '..');
    for (const dir of ['lib', 'handlers']) {
      for (const rel of readdirSync(join(root, dir), { recursive: true }) as string[]) {
        if (!rel.endsWith('.ts') || rel.includes('.test.')) continue;
        const hit = findGlabOutputFlag(readFileSync(join(root, dir, rel), 'utf8'));
        if (hit) offenders.push(`${dir}/${rel}: ${hit}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // The scanner's own fixtures: a guard tested only against a clean tree cannot
  // tell a working scanner from one that matches nothing.
  describe('findGlabOutputFlag', () => {
    test('a trailing comment naming the forbidden form is not a hit (#594)', () => {
      expect(findGlabOutputFlag("doThing(); // glab mr view -F json\n")).toBeNull();
      expect(findGlabOutputFlag("const x = 1; /* glab label list -F json */\n")).toBeNull();
      expect(
        findGlabOutputFlag("run(['glab', 'api', path], cwd); // was ['glab', 'mr', 'view', h, '-F', 'json']\n"),
      ).toBeNull();
    });

    test('real calls are still caught, in argv and shell form, across lines and .push()', () => {
      expect(findGlabOutputFlag("const cmd = ['glab', 'mr', 'view', head, '-F', 'json'];")).not.toBeNull();
      expect(findGlabOutputFlag("const cmd = ['glab', 'issue', 'view', String(n), '-F', 'json'];")).not.toBeNull();
      expect(
        findGlabOutputFlag("const cmd = [\n  'glab',\n  'label',\n  'list',\n];\ncmd.push('--output', 'json');\n"),
      ).not.toBeNull();
      expect(findGlabOutputFlag('execSync(`glab label list -F json --per-page 100`);')).not.toBeNull();
      expect(findGlabOutputFlag("execGlab('glab mr view 12 --output json');")).not.toBeNull();
    });

    test('glab api is exempt, and so is a // inside a string', () => {
      expect(findGlabOutputFlag("runArgv(['glab', 'api', 'graphql', '-F', `iid=${n}`], cwd);")).toBeNull();
      expect(findGlabOutputFlag("const u = 'https://gitlab.com/x'; const cmd = ['glab', 'api', u];")).toBeNull();
      // A // in a string must not swallow the real call after it on the same line.
      expect(
        findGlabOutputFlag("const u = 'https://x'; const cmd = ['glab', 'issue', 'view', '1', '-F', 'json'];"),
      ).not.toBeNull();
    });

    test('a quote inside a regex literal does not hide a later call', () => {
      expect(
        findGlabOutputFlag("const re = /['\"]/; const cmd = ['glab', 'label', 'list', '-F', 'json'];"),
      ).not.toBeNull();
    });

    // The shell-quote idiom nests a template inside `${…}` (pr-merge-gitlab.ts,
    // shell-escape.ts). Reading `${…}` as opaque text ends the outer template at
    // the inner backtick and inverts string and code for the rest of the file.
    const SHELL_QUOTE = "return `'${value.replace(/'/g, `'\\\\''`)}'`;\n";

    test('after a nested template, a comment naming the forbidden form is not a hit', () => {
      expect(findGlabOutputFlag(SHELL_QUOTE + '// glab mr view -F json\n')).toBeNull();
      expect(findGlabOutputFlag(SHELL_QUOTE + 'run(); // glab mr view -F json\n')).toBeNull();
    });

    test('after a nested template, a real call is still a hit', () => {
      expect(
        findGlabOutputFlag(SHELL_QUOTE + "const cmd = ['glab', 'issue', 'view', n, '-F', 'json'];\n"),
      ).not.toBeNull();
      expect(
        findGlabOutputFlag(SHELL_QUOTE + 'execSync(`glab issue view https://x/1 -F json`);\n'),
      ).not.toBeNull();
    });

    test('a regex after return is a regex, so its // does not swallow a later call', () => {
      expect(
        findGlabOutputFlag(
          "return /https?:\\/\\//.test(x) && run(['glab', 'mr', 'view', h, '-F', 'json']);\n",
        ),
      ).not.toBeNull();
    });
  });

  describe('stripTsComments', () => {
    test('removes line and block comments, keeps literals and newlines', () => {
      const src = "a(); // x\nconst s = 'b // c';\n/* d\ne */ f(`g // h`);\n";
      expect(stripTsComments(src)).toBe("a(); \nconst s = 'b // c';\n\n f(`g // h`);\n");
    });

    test('keeps a regex literal that contains // or a quote', () => {
      const src = "const r = /https?:\\/\\//; const q = /['\"]/g; // tail\n";
      expect(stripTsComments(src)).toBe("const r = /https?:\\/\\//; const q = /['\"]/g; \n");
    });

    test('tracks nested templates and interpolations, braces included', () => {
      const src = "f(`a ${g({ k: `b ${h} // c` })} // d`); // e\nx(); /* y */\n";
      expect(stripTsComments(src)).toBe("f(`a ${g({ k: `b ${h} // c` })} // d`); \nx(); \n");
    });
  });
});
