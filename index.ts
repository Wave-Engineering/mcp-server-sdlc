#!/usr/bin/env bun
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { handlers } from './handlers/_registry';
import { log } from './logger';
import { checkDeployFreshness } from './lib/deploy_freshness.js';
import { ghFreshnessDeps } from './lib/deploy_freshness_gh.js';

const SERVER_VERSION = '1.0.0';

const server = new Server(
  { name: 'sdlc-server', version: SERVER_VERSION },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: handlers.map(h => ({
    name: h.name,
    description: h.description,
    inputSchema: zodToJsonSchema(h.inputSchema) as Record<string, unknown>,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const h = handlers.find(h => h.name === req.params.name);
  if (!h) throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${req.params.name}`);
  const parsed = h.inputSchema.safeParse(req.params.arguments);
  if (!parsed.success) throw new McpError(ErrorCode.InvalidParams, parsed.error.message);

  const start = Date.now();
  try {
    const result = await h.execute(parsed.data);
    log.info('tool_call', { tool: h.name, ok: true, ms: Date.now() - start });
    return result;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error('tool_call', { tool: h.name, ok: false, ms: Date.now() - start, error });
    throw err;
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
log.info('startup', { version: SERVER_VERSION, config: { handler_count: handlers.length } });

// #447 — one-time deploy-freshness check. Fire-and-forget: it must not block the
// transport, and it swallows every failure internally, so a bare .catch() here is
// belt-and-suspenders against an unexpected throw.
void checkDeployFreshness(ghFreshnessDeps).catch(() => {});
