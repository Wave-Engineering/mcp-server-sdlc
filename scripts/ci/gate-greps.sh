#!/usr/bin/env bash
# Handler discipline gate-greps (R-09, R-10, #527).
#
# Three greps run against handlers/*.ts MINUS the entries in
# scripts/ci/migration-allowlist.txt:
#
#   1. `if (platform === 'github'|'gitlab')` — inline platform branching (R-09)
#   2. `execSync('gh ...'|'glab ...')` or `Bun.spawnSync(...)` — direct
#       subprocess invocation (R-10)
#   3. `envelope({ ok: false, error: result.error })` — dropping the adapter's
#       typed error `code` on the ok:false path (#527)
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

# Gate-grep #3 — dropping the adapter error `code` on the ok:false envelope (#527).
# `if (!result.ok) return envelope({ ok: false, error: result.error })` silently
# discards the typed `code` the adapter returned, un-typing every failure for MCP
# callers (e.g. pr_merge_wait's pr_merge_blocked / enrolled_merge_failed). Preserve
# it: `{ ok: false, code: result.code, error: result.error }` (code either side of
# error is fine). The first grep finds an ok:false envelope relaying `result.error`;
# the `grep -v code:` keeps only the lines with NO `code:` anywhere (the real drops),
# so a preserve line — code before OR after error — is not flagged. Catch blocks are
# excluded for free: they relay a thrown JS error via `error: err instanceof Error
# ...`, not `result.error`, so the first grep never matches them.
#
# SCOPE — this is a HEURISTIC first-pass, NOT the authoritative class check. It is
# keyed to the dominant `result` variable name, and it is single-line. An
# AdapterResult bound to another name (defRes, prResult, existing, created, …) or
# dropped across a multi-line envelope is NOT caught here — a grep cannot
# distinguish an AdapterResult (whose ok:false arm carries a required `code`) from
# a local result type that legitimately has none (e.g. resolveArtifactsDir's
# {ok,error}). The whole tree was swept clean of both shapes in #527.
#
# The authoritative, name-agnostic, type-aware enforcement now lives in
# scripts/ci/check-adapter-error-code.ts (#534), wired into validate.sh right
# after this script. That rule asks the TypeScript type checker whether the
# ok:false relay operand is an AdapterResult and flags any drop regardless of
# variable name or line shape — the class this grep can only approximate. This
# grep is RETAINED as a cheap first-pass (no program build); do NOT read its
# green as "the class is closed" — that guarantee is the #534 rule's job.
if grep -nE "ok:[[:space:]]*false,[[:space:]]*error:[[:space:]]*result\.error" "${handlers_to_check[@]}" | grep -v "code:"; then
    echo ""
    echo "GATE FAIL [#527]: handler drops the adapter error 'code' on an ok:false envelope."
    echo "  Use { ok: false, code: result.code, error: result.error } so callers can branch on the failure type."
    failed=1
fi

if [[ $failed -ne 0 ]]; then
    exit 1
fi

echo "gate-greps: OK"
