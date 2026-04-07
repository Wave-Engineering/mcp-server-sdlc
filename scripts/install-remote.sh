#!/usr/bin/env bash
# Install sdlc-server from a GitHub release.
# Detects platform, downloads the appropriate binary, installs to ~/.local/bin,
# and registers the MCP server in ~/.claude.json.
set -euo pipefail

REPO="Wave-Engineering/mcp-server-sdlc"
BINARY_NAME="sdlc-server"
INSTALL_DIR="${HOME}/.local/bin"
CLAUDE_CONFIG="${HOME}/.claude.json"

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

echo "Done. Restart Claude Code to activate the sdlc-server MCP."
