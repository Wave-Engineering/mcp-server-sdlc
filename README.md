# mcp-server-sdlc

SDLC workflow MCP server for Claude Code agents.

## Prerequisites

- [Bun](https://bun.sh) >= 1.0
- A `GITHUB_TOKEN` or `GITLAB_TOKEN` environment variable (required for tools that interact with GitHub/GitLab APIs)
- **Python 3.11+** (optional, but required for `commutativity_verify` — see [commutativity-probe](#commutativity-probe) below)

## Quickstart

1. **Install the binary:**
   ```bash
   curl -fsSL https://raw.githubusercontent.com/Wave-Engineering/mcp-server-sdlc/main/scripts/install-remote.sh | bash
   ```

   Install-time options:
   | Variable / flag | Effect |
   |---|---|
   | `SDLC_VERSION=v1.2.3` | Override sdlc-server release tag (default: latest release) |
   | `SDLC_PROBE_REF=<git-ref>` | Override commutativity-probe git ref (default: `v0.1.0`) |
   | `--skip-probe` | Skip commutativity-probe install (handler degrades to `verdict: PROBE_UNAVAILABLE`) |

2. **Configure your token** in `~/.claude.json` under the `sdlc-server` entry:
   ```json
   {
     "mcpServers": {
       "sdlc-server": {
         "command": "~/.local/bin/sdlc-server",
         "args": [],
         "env": {
           "GITHUB_TOKEN": "<your-token>"
         }
       }
     }
   }
   ```

3. **Restart Claude Code** to activate the server.

## Handler Registry

Tools are auto-discovered at build time via a glob pattern over `handlers/`. To add a tool, drop a file in `handlers/` that exports a `HandlerDef` default. No other files need to change.

```typescript
// handlers/my_tool.ts
import { z } from 'zod';
import type { HandlerDef } from '../types.js';

const handler: HandlerDef = {
  name: 'my_tool',
  description: 'Does something useful',
  inputSchema: z.object({ input: z.string() }),
  execute: async (args) => ({
    content: [{ type: 'text', text: `Result: ${(args as { input: string }).input}` }],
  }),
};

export default handler;
```

## commutativity-probe

The `commutativity_verify` MCP tool shells out to the
[`commutativity-probe`](https://github.com/Wave-Engineering/commutativity-probe)
Python CLI to compute changeset commutativity from real git diffs. The
installer bundles it via `pip install --user` (pinned to `v0.1.0`).

If the probe binary is missing from `PATH`, `commutativity_verify` returns
the same body shape as a timeout, with `verdict: "PROBE_UNAVAILABLE"`:

```json
{
  "ok": true,
  "mode": "pairwise",
  "verdict": "PROBE_UNAVAILABLE",
  "group_verdict": "PROBE_UNAVAILABLE",
  "pairs": [],
  "pairwise_results": [],
  "warnings": ["commutativity-probe binary not found on PATH; install via mcp-server-sdlc/scripts/install-remote.sh"]
}
```

Callers should treat `PROBE_UNAVAILABLE` as conservative-fail (sequential
merge fallback) — equivalent to `ORACLE_REQUIRED` for dispatch purposes.

To install or upgrade the probe manually:

```bash
pip install --user 'git+https://github.com/Wave-Engineering/commutativity-probe.git@v0.1.0'
```

## Tool Reference

See [docs/tool-reference.md](docs/tool-reference.md) _(coming soon)_.
