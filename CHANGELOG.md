# Changelog

## Unreleased

**BREAKING CHANGE (#362, Story 2.1):** `wave_init` no longer accepts `kahuna: { epic_id, slug }`. Callers must pass `kahuna: { plan_id, slug }` instead. The generated branch name is now `kahuna/<plan_id>-<slug>` and the wave-state schema (`KahunaBranchHistoryEntrySchema` in `lib/wave_state.ts`) renames `epic_id` → `plan_id` on each history entry. No legacy-compat fallback is provided — the legacy shape fails schema validation with a clear error. Part of the Plan/Phase/Epic taxonomy lock (cc-workflow#499): "Plan" is the pipeline's tracking-issue unit; "Epic" is now an optional PM label the pipeline ignores.

**BREAKING CHANGE (#363, Story 2.2):** `wave_finalize` no longer accepts `epic_id`. Callers must pass `plan_id`. The assembled kahuna→target MR title changes from `epic(#N): <slug> — kahuna to <target>` to `plan(#N): <slug> — kahuna to <target>`. No legacy-compat fallback; the old parameter name fails schema validation with a clear error. Part of the Plan/Phase/Epic taxonomy lock (cc-workflow#499).

### Features
- **wave_reconcile**: New Prime(post-wave) reconciliation handler emitting canonical `[drift-halt]` comments on Category B drift per Dev Spec §5.4.1. [#366, Story 2.5]
- **devspec_finalize**: Require `depends_on` field on every Story in `phases-waves.json` (may be empty array); finalization fails with a named list of offenders otherwise. [#367, Story 2.6]

### Docs
- **wave-finalize**: correct stale `<epic_id>` → `<plan_id>` comment at `lib/wave-finalize.ts:70`. [#365, Story 2.4]

### Fixes
- **ibm**: `BRANCH_PATTERN` now accepts the canonical singular `doc/` and the missing `bug/` and `kahuna/` prefixes. Previous pattern required plural `docs/` and rejected `kahuna/<N>-<slug>` integration branches outright, forcing rename-then-platform-rejection loops. [#381]
- **gitlab-api**: `execGlab` now surfaces non-zero exit codes with stderr context, and rejects zero-exit-empty-stdout with a named error instead of letting `JSON.parse('')` produce a cryptic `Unexpected EOF`. [#382]

## v1.0.2 — 2026-04-07

**Critical fix:** the v1.0.0 / v1.0.1 binaries shipped with a broken handler registry — `index.ts` used `import.meta.glob('./handlers/*.ts', { eager: true })`, which is a Vite-only feature unsupported by Bun. Result: the server crashed at startup whenever a client called `tools/list`. The `work_item` and `ibm` tools existed in the bundle but were never reachable.

Replaced with a pre-build codegen pipeline. `scripts/ci/codegen-handlers.sh` scans `handlers/*.ts` and emits `handlers/_registry.ts` with explicit imports; `index.ts` and tests both import from there. The generated file is gitignored. Codegen runs as the first step of `validate.sh` and `build.sh`.

Also added a runtime smoke test (`scripts/ci/smoke.sh`) that builds the binary, sends a real `tools/list` request via stdio MCP protocol, and asserts a non-empty response. This is the institutional discipline that catches the class of bug that shipped in v1.0.0/v1.0.1 — type checks and isolated unit tests aren't enough; actually run the binary.

Removed `bun.d.ts` (it contained a false `ImportMeta.glob` type declaration).

## v1.0.1 — 2026-04-07

ETXTBSY-safe install. `scripts/install-remote.sh` now downloads to a temp file and `mv -f`s into place, surviving the case where the binary is already running as an MCP subprocess.

## v1.0.0 — 2026-04-07

Initial release. Two tools: `work_item` (unified GitHub/GitLab work item creation) and `ibm` (issue/branch/PR workflow compliance check). **NOTE:** broken at runtime — see v1.0.2 for the fix. Do not use v1.0.0.
