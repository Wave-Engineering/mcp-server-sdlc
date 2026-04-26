#!/usr/bin/env bash
# Adapter-retrofit gate-greps (R-09, R-10).
#
# Two greps run against handlers/*.ts MINUS the entries in
# scripts/ci/migration-allowlist.txt:
#
#   1. `if (platform === 'github'|'gitlab')` — inline platform branching
#   2. `execSync('gh ...'|'glab ...')` or `Bun.spawnSync(...)` — direct
#       subprocess invocation
#
# The allowlist is the EXCLUDE list: handlers in it are exempt from the gate
# until their migration story removes them. Handlers NOT in the allowlist must
# stay clean — adding inline platform branching or a direct subprocess call to
# any non-allowlisted handler fails the build.
#
# By Phase 3 close (Story 3.6) the allowlist file is empty (or deleted) and
# the gates enforce against every handler globally.

set -euo pipefail

cd "$(dirname "$0")/../.."

ALLOWLIST=scripts/ci/migration-allowlist.txt
HANDLERS_DIR=handlers

if [[ ! -f $ALLOWLIST ]]; then
    echo "FAIL: $ALLOWLIST not found"
    exit 1
fi

# Build the set of allowed (exempt) basenames.
declare -A allowed_set=()
while IFS= read -r line; do
    # Strip leading/trailing whitespace and skip blanks/comments.
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -z $line || ${line:0:1} == "#" ]] && continue
    allowed_set["$line"]=1
done < "$ALLOWLIST"

# Build the list of handlers to check — every handlers/*.ts whose basename is
# NOT in the allowlist.
handlers_to_check=()
shopt -s nullglob
for path in "$HANDLERS_DIR"/*.ts; do
    base=$(basename "$path")
    # Skip the codegen-generated registry — never platform-aware by design.
    [[ $base == "_registry.ts" ]] && continue
    if [[ -z ${allowed_set[$base]:-} ]]; then
        handlers_to_check+=("$path")
    fi
done
shopt -u nullglob

if [[ ${#handlers_to_check[@]} -eq 0 ]]; then
    echo "gate-greps: zero handlers to check (all handlers are allowlisted)"
    exit 0
fi

echo "gate-greps: checking ${#handlers_to_check[@]} non-allowlisted handler(s)"

failed=0

# Gate-grep #1 — inline platform branching (R-09).
# Match any direct `platform === 'github'|'gitlab'` comparison, not just the
# `if (platform === ...)` statement form: ternaries and assignments
# (`const x = platform === 'github' ? ...`) violate the same constraint.
if grep -nE "platform === '(github|gitlab)'" "${handlers_to_check[@]}"; then
    echo ""
    echo "GATE FAIL [R-09]: inline platform branching found in non-allowlisted handler(s)."
    echo "  These handlers must dispatch through getAdapter() rather than branch on platform."
    failed=1
fi

# Gate-grep #2 — direct subprocess to gh/glab/Bun.spawnSync (R-10).
if grep -nE "execSync\(['\"\`](gh|glab) |Bun\.spawnSync" "${handlers_to_check[@]}"; then
    echo ""
    echo "GATE FAIL [R-10]: direct subprocess to gh/glab/Bun.spawnSync in non-allowlisted handler(s)."
    echo "  Subprocess invocation lives in lib/adapters/<method>-<platform>.ts files only."
    failed=1
fi

if [[ $failed -ne 0 ]]; then
    exit 1
fi

echo "gate-greps: OK"
