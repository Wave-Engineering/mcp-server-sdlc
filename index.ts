#!/usr/bin/env bun
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { handlers } from './handlers/_registry';
import { log } from './logger';
import { checkDeployFreshness, getBuildInfo, DEV_SENTINEL } from './lib/deploy_freshness.js';
import { ghFreshnessDeps } from './lib/deploy_freshness_gh.js';

// #459: report the release tag this binary was built at (e.g. "2.1.0"), injected
// at compile time by scripts/ci/build.sh as __BUILD_REF__ (`git describe --tags`).
// A hardcoded literal silently drifts from the tag — the old '1.0.0' made every
// release's startup log indistinguishable and undercut #447's freshness diagnostic.
// Uncompiled dev runs (ref === the 'dev' sentinel) report a dev marker rather than
// claiming to be a release.
const _build = getBuildInfo();
const SERVER_VERSION = _build.ref === DEV_SENTINEL ? '0.0.0-dev' : _build.ref.replace(/^v/, '');

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
