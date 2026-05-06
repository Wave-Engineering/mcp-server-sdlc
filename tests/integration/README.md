# Integration Tests

These tests verify CLI flag surfaces that our handlers depend on still exist.

## Contract

**Tests in this directory MUST NOT mock `child_process`.**

Their job is to verify that the flags we pass to real `gh` and `glab` binaries are valid. Mock-based unit tests can pass even when our flag combinations are broken (as happened with `glab mr view -F json` in #383 and `gh pr checks --json` in pr_wait_ci).

## Running

Integration tests run as part of `scripts/ci/validate.sh`. The suite skips cleanly when `gh` or `glab` aren't installed, so it won't break local dev environments or CI runners that don't have both CLIs.

## Test Pattern

```typescript
import { execSync } from 'child_process';

test('glab mr view does NOT accept -F json', () => {
  const help = execSync('glab mr view --help', { encoding: 'utf8' });
  expect(help).not.toMatch(/-F[, ]/);
  expect(help).not.toMatch(/--format/);
});
```

For API-based operations (like `glab api projects/...`), test the URL-encoding shape our handlers use.

## Scope

Focus on **hot-path** handlers that shell out to `gh` or `glab`:
- `ibm`
- `pr_create`
- `pr_merge` / `pr_merge_wait`
- `pr_wait_ci` / `ci_wait_run`

If a handler's CLI call is mocked in unit tests, it should have a corresponding integration test here that runs the real CLI.
