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

echo "--- tests ---"
bun test

echo "--- runtime smoke test ---"
./scripts/ci/smoke.sh

echo "=== Validation complete ==="
