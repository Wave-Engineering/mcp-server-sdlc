#!/usr/bin/env bash
# Full CI validation: codegen + TypeScript lint + shellcheck + tests + runtime smoke.
set -euo pipefail

cd "$(dirname "$0")/../.."

echo "=== SDLC MCP CI Validation ==="

echo "--- codegen ---"
./scripts/ci/codegen-handlers.sh

echo "--- TypeScript lint ---"
bun run lint

echo "--- adapter-retrofit gate-greps ---"
./scripts/ci/gate-greps.sh

# Type-aware, name-agnostic enforcement of adapter error-code preservation
# (#534). gate-greps.sh #3 above is the cheap single-line first-pass keyed to
# the `result` name; THIS is the authoritative class check — it asks the type
# checker whether the ok:false relay operand is an AdapterResult (its ok:false
# arm carries a required `code`) and flags any drop regardless of variable name
# or single/multi-line shape. See the script header for the full rationale.
echo "--- adapter error-code preservation (type-aware, #534) ---"
bun run scripts/ci/check-adapter-error-code.ts

echo "--- shellcheck ---"
shopt -s nullglob
scripts=( scripts/ci/*.sh )
shopt -u nullglob

if [[ ${#scripts[@]} -eq 0 ]]; then
    echo "No shell scripts found to check"
else
    shellcheck "${scripts[@]}"
    echo "shellcheck: ${#scripts[@]} file(s) OK"
fi

echo "--- unit tests ---"
# Exclude tests/integration/ from the mixed unit run: those tests exec REAL gh/glab
# and MUST NOT share a process with the adapter tests' `mock.module('child_process')`
# (the mock leaks across bun's shared module space; cli-flag-shapes.test.ts documents
# this). They run isolated in their own process below. (Broader 129-file mock-isolation
# is tracked separately.)
bun test --path-ignore-patterns='**/integration/**'

echo "--- flightdeck emit suite (isolated process) ---"
# The FlightDeck emit tests mutate SHARED process.env (FLIGHTDECK_EMIT_DISABLED /
# FLIGHTDECK_EVENTS_PATH) per-test to opt into emit against an isolated temp
# buffer. Bun runs all discovered *.test.ts files CONCURRENTLY in ONE process, so
# when the FD tests lived in two sibling *.test.ts files they raced on that shared
# env (one file's afterEach restore clobbered the other mid-test → emit no-op →
# ENOENT; CI-only, #464). They now live in a single non-*.test.ts suite that the
# default `bun test` above does NOT discover, and run here alone in their own
# process — no concurrent FD file to race the env. NOTE the leading `./`: bun
# treats a bare arg without .test/.spec in the name as a NAME filter (matches no
# files); the `./` prefix forces it to be read as an explicit file path.
bun test ./tests/flightdeck-emit.suite.ts

echo "--- integration tests ---"
# Real-CLI integration tests — verify flag shapes our handlers depend on.
# Skips cleanly when gh/glab aren't installed (local dev + CI runners without both).
if command -v gh >/dev/null 2>&1 || command -v glab >/dev/null 2>&1; then
    bun test tests/integration/
    echo "integration tests: OK"
else
    echo "integration tests: SKIPPED (gh/glab not installed)"
fi

echo "--- runtime smoke test ---"
./scripts/ci/smoke.sh

echo "=== Validation complete ==="
