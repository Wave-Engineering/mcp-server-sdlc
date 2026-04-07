#!/usr/bin/env bash
# Create a GitHub Release and attach all artifacts.
# Usage: release.sh <tag>
set -euo pipefail

TAG="${1:?Usage: release.sh <tag>}"

echo "=== Creating release ${TAG} ==="

mkdir -p release-assets
find artifacts -type f -name 'sdlc-server-*' -exec cp {} release-assets/ \;
find release-assets -type f -name 'sdlc-server-*' -exec chmod +x {} \;

gh release create "$TAG" release-assets/* \
    --title "$TAG" \
    --generate-notes

echo "=== Release ${TAG} created ==="
