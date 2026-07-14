# Changelog

## Unreleased

**BREAKING CHANGE (#362, Story 2.1):** `wave_init` no longer accepts `kahuna: { epic_id, slug }`. Callers must pass `kahuna: { plan_id, slug }` instead. The generated branch name is now `kahuna/<plan_id>-<slug>` and the wave-state schema (`KahunaBranchHistoryEntrySchema` in `lib/wave_state.ts`) renames `epic_id` → `plan_id` on each history entry. No legacy-compat fallback is provided — the legacy shape fails schema validation with a clear error. Part of the Plan/Phase/Epic taxonomy lock (cc-workflow#499): "Plan" is the pipeline's tracking-issue unit; "Epic" is now an optional PM label the pipeline ignores.

**BREAKING CHANGE (#363, Story 2.2):** `wave_finalize` no longer accepts `epic_id`. Callers must pass `plan_id`. The assembled kahuna→target MR title changes from `epic(#N): <slug> — kahuna to <target>` to `plan(#N): <slug> — kahuna to <target>`. No legacy-compat fallback; the old parameter name fails schema validation with a clear error. Part of the Plan/Phase/Epic taxonomy lock (cc-workflow#499).

### Features
- **deploy-freshness check**: the `sdlc-server` binary now embeds its build commit SHA (via `bun build --define`) and, once at startup, emits a `warn`-level `deploy_freshness` log line when that commit is **behind** this repo's latest GitHub release — naming both and the remedy (`redeploy with ./install --mcps`). Uses GitHub's commit-compare API for an **exact** ancestry check, not a date heuristic. **Network-optional**: offline / unauthenticated / no-releases all degrade to silence; it never blocks startup, never spams, and never warns on a build that is newer than the latest release or on an uncompiled dev build. Motivated by a stale deploy that lagged the latest release by four merged fixes with no signal anywhere. [#447]
- **work_item**: `type: "plan"` is now a first-class type, applying the `type::plan` label. `/issue plan` previously could not create a Plan issue at all — the enum had no `plan` — and callers worked around it with `type: "epic"` plus an explicit `type::plan` label. [#477]

### Fixes
- **ci_wait_run**: the `expected_sha` first-appearance window is now **bounded** (~180s) instead of coupled to the full `timeout_sec`. Previously, passing `expected_sha` set the "no run has appeared yet" grace window to the *entire* timeout (typically 1800s), so a transient first-poll miss made the tool spin **silently for 30 minutes** with zero partial output (diagnosed live by wintermute on a `/scpmmr` post-merge wait). The `require_merge_result` path keeps its full-timeout appearance window — a GitLab merged-results pipeline is created asynchronously and can take minutes to appear, so bounding *that* would spuriously HOLD every wave (#452 in reverse). Phase 2 (polling a run that has appeared) still honors the full `timeout_sec`. [#483]
- **ibm**: now accepts an optional `repo`, and **refuses rather than guesses** when asked about a branch that is not the one checked out in the server's cwd without one (#475). Previously `ibm` resolved the repo from the process cwd only: an agent working in a different repo — passing a branch from that repo — had the issue number parsed out of the branch and looked up in the **cwd's** repo, where a same-numbered but entirely unrelated issue would match and `ibm` would report "branch is correctly linked". That is a **false pass on the first gate of `/precheck`**, a mandatory compliance check that only looked like it was enforcing. The verdict envelope now also echoes the `repo` actually checked. [#475]
- **work_item**: the automatic `type::<type>` label is now **suppressed when the caller supplies any `type::*` label of their own**, on both platforms. It was previously prepended unconditionally, which was safe only **by accident** on GitLab: `type::epic` and `type::plan` share the `type::` scope key, GitLab's scoped labels are mutually exclusive, and the caller's later label evicted ours. **GitHub has no scoped labels**, so the identical call produced an issue carrying **both** — a Plan mislabelled as an Epic, which the pipeline is specified never to read (Dev Spec R-19). Relying on the target platform to clean up after us is not a contract. Caller labels are also trimmed before they reach the platform (`gh` matches label names exactly and rejects an untrimmed one outright; GitLab would mint a junk label). A missing-label failure on GitHub now names the remedy (`label_create` first — GitHub does not create labels implicitly, GitLab does). [#477]

- **plan_load_dod**: New MCP tool to fetch Plan tracking-issue and extract Definition of Done structure — both Plan-level DoD checkboxes and per-Phase DoD checklists with [R-XX] refs. Returns parsed view including Dev Spec path from References section. Part of the Plan DoD workflow family. [#388]
- **wave_reconcile**: New Prime(post-wave) reconciliation handler emitting canonical `[drift-halt]` comments on Category B drift per Dev Spec §5.4.1. [#366, Story 2.5]
- **devspec_finalize**: Require `depends_on` field on every Story in `phases-waves.json` (may be empty array); finalization fails with a named list of offenders otherwise. [#367, Story 2.6]

### Docs
- **wave-finalize**: correct stale `<epic_id>` → `<plan_id>` comment at `lib/wave-finalize.ts:70`. [#365, Story 2.4]

### Fixes
- **wave_finalize**: `root` now roots the entire operation — the PR find/create adapter calls honor it too, not just the wave-status read + branch probe. Optional `cwd?` threaded through `PrCreateArgs`/`FindExistingPrArgs`, both platform adapters, and the GitLab slug-resolution path (`parse-repo-slug`, `gitlab-api`); byte-identical when omitted. A cross-repo wave (`root` ≠ session) no longer find/opens the PR against the wrong repo. [#453]
- **test(ci)**: isolate the real-CLI integration tests from the adapter `mock.module('child_process')` mocks — they run in their own process (`--path-ignore-patterns` excludes them from the mixed unit run). Partial mitigation for the load-order CI flake tracked in [#455]; the unit-level victims need the full mock-isolation refactor (a static ESM-import binding makes a test-level fix impossible).
- **ibm**: `BRANCH_PATTERN` now accepts the canonical singular `doc/` and the missing `bug/` and `kahuna/` prefixes. Previous pattern required plural `docs/` and rejected `kahuna/<N>-<slug>` integration branches outright, forcing rename-then-platform-rejection loops. [#381]
- **gitlab-api**: `execGlab` now surfaces non-zero exit codes with stderr context, and rejects zero-exit-empty-stdout with a named error instead of letting `JSON.parse('')` produce a cryptic `Unexpected EOF`. [#382]
- **pr_create (gitlab)**: replaced the post-create lookup `glab mr view <head> -F json` with `glab api projects/.../merge_requests?source_branch=<head>&state=opened`. The `-F` flag does not exist on glab 1.36.0, so every successful create was being followed by a failed lookup, the handler reported `glab_mr_view_failed`, and callers fell back into a 409 conflict. The mock-based test suite missed it (same family as `lesson_pr_wait_ci_broken.md`). [#383]

## v1.0.2 — 2026-04-07

**Critical fix:** the v1.0.0 / v1.0.1 binaries shipped with a broken handler registry — `index.ts` used `import.meta.glob('./handlers/*.ts', { eager: true })`, which is a Vite-only feature unsupported by Bun. Result: the server crashed at startup whenever a client called `tools/list`. The `work_item` and `ibm` tools existed in the bundle but were never reachable.

Replaced with a pre-build codegen pipeline. `scripts/ci/codegen-handlers.sh` scans `handlers/*.ts` and emits `handlers/_registry.ts` with explicit imports; `index.ts` and tests both import from there. The generated file is gitignored. Codegen runs as the first step of `validate.sh` and `build.sh`.

Also added a runtime smoke test (`scripts/ci/smoke.sh`) that builds the binary, sends a real `tools/list` request via stdio MCP protocol, and asserts a non-empty response. This is the institutional discipline that catches the class of bug that shipped in v1.0.0/v1.0.1 — type checks and isolated unit tests aren't enough; actually run the binary.

Removed `bun.d.ts` (it contained a false `ImportMeta.glob` type declaration).

## v1.0.1 — 2026-04-07

ETXTBSY-safe install. `scripts/install-remote.sh` now downloads to a temp file and `mv -f`s into place, surviving the case where the binary is already running as an MCP subprocess.

## v1.0.0 — 2026-04-07

Initial release. Two tools: `work_item` (unified GitHub/GitLab work item creation) and `ibm` (issue/branch/PR workflow compliance check). **NOTE:** broken at runtime — see v1.0.2 for the fix. Do not use v1.0.0.
