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

# Report a failed curl fetch and exit (#600). curl's exit status says which way it
# failed: the host could not be reached at all, or it answered with an HTTP error
# (-f makes curl exit 22 on 4xx/5xx).
# Usage: fetch_failed <curl-exit> <http-code> <url> <what the fetch was doing> [hint]
# The hint follows an HTTP error other than 404, the one failure a pin can get past.
fetch_failed() {
    local rc="$1" code="$2" url="$3" doing="$4" hint="${5:+ $5}"
    case "$rc" in
        6|7|28|35)
            echo "Network error while ${doing}: could not reach ${url} (curl exit ${rc}). Check the network or proxy, then re-run." >&2
            ;;
        22)
            if [[ "$code" == "404" ]]; then
                echo "HTTP 404 while ${doing}: ${url} does not exist." >&2
            else
                echo "HTTP ${code} while ${doing}: GitHub refused or failed the request for ${url}.${hint}" >&2
            fi
            ;;
        *)
            echo "curl failed (exit ${rc}) while ${doing}: ${url}." >&2
            ;;
    esac
    exit 1
}

# Resolve latest release tag from the releases/latest redirect, which lands on
# .../releases/tag/<tag>. Not the unauthenticated api.github.com endpoint: its
# 60/hour per-IP limit 403s on shared CI runners (#598). A pin skips the lookup.
LATEST_URL="https://github.com/${REPO}/releases/latest"
RESOLVED=""
if [[ -n "${SDLC_VERSION:-}" ]]; then
    TAG="${SDLC_VERSION}"
else
    RC=0
    RESOLVED="$(curl -fsSIL -o /dev/null -w '%{http_code} %{url_effective}' "${LATEST_URL}")" || RC=$?
    [[ "$RC" -eq 0 ]] || fetch_failed "$RC" "${RESOLVED%% *}" "${LATEST_URL}" "resolving the latest release" \
        "Set SDLC_VERSION to a release tag (e.g. v1.2.3) to skip this lookup."
    # Empty unless the redirect landed on a tag page.
    TAG="$(printf '%s\n' "${RESOLVED#* }" | sed -n 's#.*/tag/##p')"
fi

if [[ -z "$TAG" ]]; then
    echo "Could not determine release tag: ${LATEST_URL} led to ${RESOLVED#* }, not a release. Set SDLC_VERSION to override." >&2
    exit 1
fi

# A pin is checked too, so SDLC_VERSION=5.0.0 fails here, not at download.
if [[ ! "$TAG" =~ ^v[0-9] ]]; then
    echo "Release tag '${TAG}' does not look like a tag. Set SDLC_VERSION to a release tag (e.g. v1.2.3) to override." >&2
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
RC=0
FETCHED="$(curl -fsSL --progress-bar -w '%{http_code} %{url_effective}' "${DOWNLOAD_URL}" -o "${TMP}")" || RC=$?
if [[ "$RC" -ne 0 ]]; then
    # github.com redirects the asset to a CDN host that a proxy can block on its own,
    # so name the URL curl actually failed on. Its query string is a signed token.
    WHERE="${FETCHED#* }"
    WHERE="${WHERE%%\?*}"
    if [[ -n "$WHERE" && "$WHERE" != "${DOWNLOAD_URL}" ]]; then
        WHERE="${WHERE} (redirected from ${DOWNLOAD_URL})"
    else
        WHERE="${DOWNLOAD_URL}"
    fi
    fetch_failed "$RC" "${FETCHED%% *}" "${WHERE}" "downloading ${BINARY_NAME} ${TAG}"
fi
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
        PROBE_INSTALLED=false

        # Strategy 1: pipx (preferred — manages its own venv, PEP 668 safe)
        if command -v pipx >/dev/null 2>&1; then
            echo "  → trying pipx..."
            if pipx install "git+${PROBE_REPO_URL}@${PROBE_REF}" >/dev/null 2>&1 \
                || pipx install --force "git+${PROBE_REPO_URL}@${PROBE_REF}" >/dev/null 2>&1; then
                PROBE_INSTALLED=true
            fi
        fi

        # Strategy 2: persistent venv + symlink (PEP 668 safe, no pipx needed)
        if [[ "${PROBE_INSTALLED}" == false ]]; then
            echo "  → trying venv fallback..."
            PROBE_VENV="${HOME}/.local/share/commutativity-probe-venv"
            rm -rf "${PROBE_VENV}" 2>/dev/null || true
            if python3 -m venv "${PROBE_VENV}" 2>/dev/null \
                && "${PROBE_VENV}/bin/pip" install --quiet "git+${PROBE_REPO_URL}@${PROBE_REF}" 2>/dev/null \
                && [[ -x "${PROBE_VENV}/bin/commutativity-probe" ]]; then
                ln -sf "${PROBE_VENV}/bin/commutativity-probe" "${INSTALL_DIR}/commutativity-probe"
                PROBE_INSTALLED=true
            fi
        fi

        # Strategy 3: pip --user (legacy systems without PEP 668)
        if [[ "${PROBE_INSTALLED}" == false ]]; then
            echo "  → trying pip install --user..."
            if python3 -m pip install --user --quiet "git+${PROBE_REPO_URL}@${PROBE_REF}" 2>/dev/null; then
                PROBE_INSTALLED=true
            fi
        fi

        if [[ "${PROBE_INSTALLED}" == true ]]; then
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
