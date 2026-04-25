#!/usr/bin/env bash
# Install sdlc-server from a GitHub release.
# Detects platform, downloads the appropriate binary, installs to ~/.local/bin,
# registers the MCP server in ~/.claude.json, and bundles the
# commutativity-probe Python CLI (skip with --skip-probe).
set -euo pipefail

REPO="Wave-Engineering/mcp-server-sdlc"
BINARY_NAME="sdlc-server"
INSTALL_DIR="${HOME}/.local/bin"
CLAUDE_CONFIG="${HOME}/.claude.json"

# Probe install config (#218). Pin to v0.1.0 by default; SDLC_PROBE_REF env
# var overrides for dev/CI without editing the script.
PROBE_REPO_URL="https://github.com/Wave-Engineering/commutativity-probe.git"
PROBE_REF="${SDLC_PROBE_REF:-v0.1.0}"

# Parse flags. Currently only --skip-probe; positional args ignored.
SKIP_PROBE=0
for arg in "$@"; do
    case "$arg" in
        --skip-probe) SKIP_PROBE=1 ;;
        --help|-h)
            echo "Usage: install-remote.sh [--skip-probe]"
            echo "  --skip-probe          Skip commutativity-probe install"
            echo "  SDLC_VERSION=...      Override sdlc-server release tag"
            echo "  SDLC_PROBE_REF=...    Override commutativity-probe git ref (default: v0.1.0)"
            exit 0
            ;;
    esac
done

# Detect platform
OS="$(uname -s)"
ARCH="$(uname -m)"

case "${OS}-${ARCH}" in
    Linux-x86_64)   PLATFORM="linux-x64" ;;
    Darwin-x86_64)  PLATFORM="darwin-x64" ;;
    Darwin-arm64)   PLATFORM="darwin-arm64" ;;
    *)
        echo "Unsupported platform: ${OS}-${ARCH}" >&2
        exit 1
        ;;
esac

# Resolve latest release tag
TAG="${SDLC_VERSION:-$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | sed 's/.*"tag_name": "\(.*\)".*/\1/')}"

if [[ -z "$TAG" ]]; then
    echo "Could not determine release tag. Set SDLC_VERSION to override." >&2
    exit 1
fi

DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${TAG}/${BINARY_NAME}-${PLATFORM}"

echo "Installing ${BINARY_NAME} ${TAG} for ${PLATFORM}..."

mkdir -p "${INSTALL_DIR}"
# Download to a temp file and rename into place.
# Direct -o on the final path would fail with ETXTBSY if the binary is
# currently running (e.g. Claude Code has it open as an MCP subprocess).
# rename(2) unlinks the old inode but keeps it alive for running processes.
TMP="${INSTALL_DIR}/${BINARY_NAME}.tmp.$$"
trap 'rm -f "${TMP}"' EXIT
curl -fsSL --progress-bar "${DOWNLOAD_URL}" -o "${TMP}"
chmod +x "${TMP}"
mv -f "${TMP}" "${INSTALL_DIR}/${BINARY_NAME}"
trap - EXIT

echo "Installed to ${INSTALL_DIR}/${BINARY_NAME}"

# Register MCP server in ~/.claude.json
if command -v jq &>/dev/null && [[ -f "${CLAUDE_CONFIG}" ]]; then
    BINARY_PATH="${INSTALL_DIR}/${BINARY_NAME}"
    jq --arg path "${BINARY_PATH}" \
       '.mcpServers["sdlc-server"] = {"command": $path, "args": [], "env": {}}' \
       "${CLAUDE_CONFIG}" > "${CLAUDE_CONFIG}.tmp" && mv "${CLAUDE_CONFIG}.tmp" "${CLAUDE_CONFIG}"
    echo "Registered sdlc-server in ${CLAUDE_CONFIG}"
else
    echo "Note: jq not found or ${CLAUDE_CONFIG} missing — register manually:"
    echo "  Add sdlc-server to mcpServers in ${CLAUDE_CONFIG} with command: ${INSTALL_DIR}/${BINARY_NAME}"
fi

# --- commutativity-probe install (#218) ---
# Bundled so a fresh sdlc-server install gets a working `commutativity_verify`
# tool out of the box. Skip with --skip-probe; failure here warns but does
# NOT fail the sdlc-server install (the handler degrades gracefully via
# PROBE_UNAVAILABLE verdict when the binary is missing).

echo ""
if [[ "${SKIP_PROBE}" -eq 1 ]]; then
    echo "Skipping commutativity-probe install (--skip-probe set)"
elif ! command -v python3 >/dev/null 2>&1; then
    echo "  ✗ python3 not found — skipping commutativity-probe install"
    echo "    The handler will return verdict=PROBE_UNAVAILABLE until installed."
    echo "    Hint: install Python 3.11+ and re-run, or use --skip-probe to silence."
else
    PY_VERSION="$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null || echo "0.0")"
    PY_MAJOR="${PY_VERSION%%.*}"
    PY_MINOR="${PY_VERSION##*.}"
    if [[ "${PY_MAJOR}" -lt 3 ]] || { [[ "${PY_MAJOR}" -eq 3 ]] && [[ "${PY_MINOR}" -lt 11 ]]; }; then
        echo "  ✗ python3 ${PY_VERSION} too old (need 3.11+) — skipping commutativity-probe install"
        echo "    The handler will return verdict=PROBE_UNAVAILABLE until installed."
    else
        echo "Installing commutativity-probe @ ${PROBE_REF}..."
        if pip install --user --quiet "git+${PROBE_REPO_URL}@${PROBE_REF}"; then
            if command -v commutativity-probe >/dev/null 2>&1 && commutativity-probe --help >/dev/null 2>&1; then
                echo "  ✓ commutativity-probe installed and verified"
            else
                echo "  ⚠️  commutativity-probe installed but not on PATH or --help failed"
                echo "    Ensure ${INSTALL_DIR} is in PATH (see warning below)."
            fi
        else
            echo "  ✗ pip install failed for commutativity-probe — skipping"
            echo "    The handler will return verdict=PROBE_UNAVAILABLE until installed."
        fi
    fi
fi

# --- ~/.local/bin PATH check (#218) ---
# pip --user puts console scripts in ~/.local/bin. Most users have it on PATH
# via shell profile, but Claude Code's MCP subprocess env can be sparser. Warn
# at install time so the user can fix it before the missing-binary symptom
# appears at probe-invocation time.
case ":${PATH}:" in
    *":${INSTALL_DIR}:"*)
        # ~/.local/bin already on PATH — nothing to do.
        ;;
    *)
        echo ""
        echo "⚠️  ${INSTALL_DIR} is not in your PATH."
        echo "    sdlc-server and commutativity-probe will not be found at runtime."
        echo "    Add to your shell profile (~/.bashrc or ~/.zshrc):"
        echo "      export PATH=\"\$HOME/.local/bin:\$PATH\""
        echo "    Then restart your shell and Claude Code."
        ;;
esac

echo ""
echo "Done. Restart Claude Code to activate the sdlc-server MCP."
