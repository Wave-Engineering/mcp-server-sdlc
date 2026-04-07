# Changelog

## v1.0.2 — 2026-04-07

**Critical fix:** the v1.0.0 / v1.0.1 binaries shipped with a broken handler registry — `index.ts` used `import.meta.glob('./handlers/*.ts', { eager: true })`, which is a Vite-only feature unsupported by Bun. Result: the server crashed at startup whenever a client called `tools/list`. The `work_item` and `ibm` tools existed in the bundle but were never reachable.

Replaced with a pre-build codegen pipeline. `scripts/ci/codegen-handlers.sh` scans `handlers/*.ts` and emits `handlers/_registry.ts` with explicit imports; `index.ts` and tests both import from there. The generated file is gitignored. Codegen runs as the first step of `validate.sh` and `build.sh`.

Also added a runtime smoke test (`scripts/ci/smoke.sh`) that builds the binary, sends a real `tools/list` request via stdio MCP protocol, and asserts a non-empty response. This is the institutional discipline that catches the class of bug that shipped in v1.0.0/v1.0.1 — type checks and isolated unit tests aren't enough; actually run the binary.

Removed `bun.d.ts` (it contained a false `ImportMeta.glob` type declaration).

## v1.0.1 — 2026-04-07

ETXTBSY-safe install. `scripts/install-remote.sh` now downloads to a temp file and `mv -f`s into place, surviving the case where the binary is already running as an MCP subprocess.

## v1.0.0 — 2026-04-07

Initial release. Two tools: `work_item` (unified GitHub/GitLab work item creation) and `ibm` (issue/branch/PR workflow compliance check). **NOTE:** broken at runtime — see v1.0.2 for the fix. Do not use v1.0.0.
