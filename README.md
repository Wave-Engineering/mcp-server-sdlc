# mcp-server-sdlc

SDLC workflow MCP server for Claude Code agents.

## Prerequisites

- [Bun](https://bun.sh) >= 1.0
- A `GITHUB_TOKEN` or `GITLAB_TOKEN` environment variable (required for tools that interact with GitHub/GitLab APIs)

## Quickstart

1. **Install the binary:**
   ```bash
   curl -fsSL https://raw.githubusercontent.com/Wave-Engineering/mcp-server-sdlc/main/scripts/install-remote.sh | bash
   ```

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

## Tool Reference

See [docs/tool-reference.md](docs/tool-reference.md) _(coming soon)_.
