#!/usr/bin/env bun
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { handlers } from './handlers/_registry';

const server = new Server(
  { name: 'sdlc-server', version: '1.0.0' },
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
  return h.execute(parsed.data);
});

const transport = new StdioServerTransport();
await server.connect(transport);
