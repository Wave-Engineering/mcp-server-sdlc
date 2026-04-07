#!/usr/bin/env bash
# Full CI validation: TypeScript lint + shellcheck + tests.
set -euo pipefail

echo "=== SDLC MCP CI Validation ==="

echo "--- TypeScript lint ---"
bun run lint

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

echo "=== Validation complete ==="
