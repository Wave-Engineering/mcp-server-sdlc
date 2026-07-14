#!/usr/bin/env bash
# Build standalone binaries for one or all supported platforms.
# Usage: build.sh [bun-target]
#   With no argument: builds all 3 platforms.
#   With a target argument (used by release CI matrix): builds that target only.
set -euo pipefail

cd "$(dirname "$0")/../.."

# Generate the handler registry before bundling. The registry is git-ignored
# and must be fresh on every build (Bun does not support import.meta.glob).
./scripts/ci/codegen-handlers.sh

mkdir -p dist

# #447 — embed build provenance so a running binary can tell whether it is behind
# its own latest release. `bun build --define` replaces these identifiers at compile
# time; in dev/test (uncompiled) they are absent and the freshness check treats the
# build as a dev build and skips. Degrade gracefully if git metadata is unavailable.
BUILD_SHA="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
BUILD_REF="$(git describe --tags --always --dirty 2>/dev/null || echo unknown)"
BUILD_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

TARGETS=("${1:-}")
if [[ -z "${1:-}" ]]; then
    TARGETS=(bun-linux-x64 bun-darwin-arm64 bun-darwin-x64)
fi

for TARGET in "${TARGETS[@]}"; do
    SUFFIX="${TARGET#bun-}"
    bun build --compile --target="$TARGET" index.ts --outfile "dist/sdlc-server-${SUFFIX}" \
        --define "__BUILD_SHA__=\"${BUILD_SHA}\"" \
        --define "__BUILD_REF__=\"${BUILD_REF}\"" \
        --define "__BUILD_AT__=\"${BUILD_AT}\""
    echo "Built dist/sdlc-server-${SUFFIX}"
done
