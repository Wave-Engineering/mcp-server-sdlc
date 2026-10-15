# Integration Tests

These tests verify CLI flag surfaces that our handlers depend on still exist.

## Contract

**Tests in this directory MUST NOT mock `child_process`.**

Their job is to verify that the flags we pass to real `gh` and `glab` binaries are valid. Mock-based unit tests can pass even when our flag combinations are broken (as happened with `glab mr view -F json` in #383 and `gh pr checks --json` in pr_wait_ci).

## Running

Integration tests run as part of `scripts/ci/validate.sh`. The CLI flag-shape blocks skip (observably) when `gh` or `glab` isn't installed. The source-level guards never skip, because they read our code and not a CLI.

## Test Pattern

Assert that a flag we **depend on** is present, using `matchOrSkip` so a missing CLI skips observably rather than passing silently:

```typescript
test('glab mr merge accepts --sha', () => {
  const help = captureHelp('glab mr merge --help');
  matchOrSkip(help, /--sha/);
});
```

**Do not assert that a CLI *lacks* a flag.** That tests the CLI, not us, and it breaks when the CLI adds the flag. glab 1.53 added `-F, --output` to `mr view` and turned the old #383 guard red on every box (#590). To guard against *our* code depending on a flag, scan our source instead. The #383 guard (`GitLab adapter source` in `cli-flag-shapes.test.ts`) does this over each file's whole comment-stripped text, so multi-line argv arrays and `.push()`ed flags are caught.

For API-based operations (like `glab api projects/...`), test the URL-encoding shape our handlers use.

## Scope

Focus on **hot-path** handlers that shell out to `gh` or `glab`:
- `ibm`
- `pr_create`
- `pr_merge` / `pr_merge_wait`
- `pr_wait_ci` / `ci_wait_run`

If a handler's CLI call is mocked in unit tests, it should have a corresponding integration test here that runs the real CLI.
