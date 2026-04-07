#!/usr/bin/env bash
# Build standalone binaries for one or all supported platforms.
# Usage: build.sh [bun-target]
#   With no argument: builds all 3 platforms.
#   With a target argument (used by release CI matrix): builds that target only.
set -euo pipefail

mkdir -p dist

TARGETS=("${1:-}")
if [[ -z "${1:-}" ]]; then
    TARGETS=(bun-linux-x64 bun-darwin-arm64 bun-darwin-x64)
fi

for TARGET in "${TARGETS[@]}"; do
    SUFFIX="${TARGET#bun-}"
    bun build --compile --target="$TARGET" index.ts --outfile "dist/sdlc-server-${SUFFIX}"
    echo "Built dist/sdlc-server-${SUFFIX}"
done
