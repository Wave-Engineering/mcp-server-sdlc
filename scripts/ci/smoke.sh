#!/usr/bin/env bash
# Runtime smoke test: build the binary, send a tools/list request via stdio MCP
# protocol, assert a non-empty tool array comes back. This is the test that
# would have caught the import.meta.glob bug from epic #287.
#
# DO NOT REMOVE this step. Type-checking and isolated unit tests are
# insufficient verification for runtime registry behavior. The institutional
# discipline is "actually start the server, send a real MCP protocol call,
# assert expected output." Non-negotiable for every Bun MCP server.

set -euo pipefail

cd "$(dirname "$0")/../.."

# Make sure the registry is fresh before building.
./scripts/ci/codegen-handlers.sh

SMOKE_BIN="/tmp/sdlc-smoke-$$"
trap 'rm -f "$SMOKE_BIN"' EXIT

# Detect target — default to bun-linux-x64, override via SMOKE_TARGET env.
TARGET="${SMOKE_TARGET:-bun-linux-x64}"

echo "smoke: building $SMOKE_BIN for $TARGET"
bun build --compile --target="$TARGET" index.ts --outfile "$SMOKE_BIN" >/dev/null

# Send a JSON-RPC tools/list request via stdio. The MCP server reads
# line-delimited JSON from stdin and writes responses to stdout.
REQUEST='{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

echo "smoke: sending tools/list to $SMOKE_BIN"
RESPONSE=$(printf '%s\n' "$REQUEST" | "$SMOKE_BIN" 2>/dev/null || true)

if [[ -z "$RESPONSE" ]]; then
    echo "SMOKE FAILED: server returned empty response"
    exit 1
fi

# Assert response contains a "tools" key with at least one entry.
if ! echo "$RESPONSE" | grep -q '"tools"'; then
    echo "SMOKE FAILED: response does not contain a tools key"
    echo "  response: $RESPONSE"
    exit 1
fi

# Assert the tools array is non-empty (look for at least one "name" inside it).
if ! echo "$RESPONSE" | grep -q '"name"'; then
    echo "SMOKE FAILED: tools array is empty (no tool name found)"
    echo "  response: $RESPONSE"
    exit 1
fi

TOOL_COUNT=$(echo "$RESPONSE" | jq -r '.result.tools | length')
echo "smoke: tools/list returned $TOOL_COUNT tools"

# Per-tool presence assertions (Option B: derived from handlers/*.ts at runtime)
echo ""
echo "Per-tool presence assertions:"

MISSING_COUNT=0
PASSED_COUNT=0

# Derive expected tool names from handlers directory (exclude files starting with _)
for handler_file in handlers/*.ts; do
    # Skip if no files match
    [[ -e "$handler_file" ]] || continue

    # Extract basename without extension
    tool_name=$(basename "$handler_file" .ts)

    # Skip underscore-prefixed files
    if [[ "$tool_name" == _* ]]; then
        continue
    fi

    # Check if tool_name appears in the tools/list response
    if echo "$RESPONSE" | jq -e ".result.tools[] | select(.name == \"$tool_name\")" >/dev/null 2>&1; then
        echo "  [+] $tool_name"
        PASSED_COUNT=$((PASSED_COUNT + 1))
    else
        echo "  [✗] $tool_name MISSING"
        MISSING_COUNT=$((MISSING_COUNT + 1))
    fi
done

echo ""
TOTAL_COUNT=$((PASSED_COUNT + MISSING_COUNT))
echo "=== Per-tool assertions: $PASSED_COUNT/$TOTAL_COUNT passed ==="

if [[ $MISSING_COUNT -gt 0 ]]; then
    echo "SMOKE FAILED: $MISSING_COUNT tool(s) missing from tools/list response"
    exit 1
fi

echo "=== Validation complete ==="
