#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createWebhoundMcpServer, TOOL_NAMES, VERSION } from '../core/server.mjs';

const args = new Set(process.argv.slice(2));

function printHelp() {
  console.log(`webhound-mcp ${VERSION}

Run Webhound's MCP server over stdio.

Usage:
  WEBHOUND_KEY=wh_... npx -y webhound-mcp@${VERSION}
  webhound-mcp --help
  webhound-mcp --version
  webhound-mcp --self-test

Environment:
  WEBHOUND_KEY                 Webhound API key (required for real tool calls)
  WEBHOUND_API_BASE            API base (default https://api.webhound.ai/api/v2)
  WEBHOUND_APP_BASE            App base (default https://webhound.ai)
  WEBHOUND_DEFAULT_BUDGET      Optional local setup hint; server defaults still win

Public tools:
  ${TOOL_NAMES.join('\n  ')}
`);
}

async function runSelfTest() {
  const server = createWebhoundMcpServer({
    apiKey: process.env.WEBHOUND_KEY || '',
    apiBase: process.env.WEBHOUND_API_BASE,
    appBase: process.env.WEBHOUND_APP_BASE,
    allowLocalFiles: true,
  });
  const summary = {
    ok: true,
    version: VERSION,
    tool_count: TOOL_NAMES.length,
    required_tools_present: TOOL_NAMES,
    has_key: !!process.env.WEBHOUND_KEY,
    note: process.env.WEBHOUND_KEY
      ? 'Server factory loaded. Use an MCP client health call for live auth verification.'
      : 'Server factory loaded. Set WEBHOUND_KEY to verify live auth.',
  };
  await server.close().catch(() => {});
  console.log(JSON.stringify(summary, null, 2));
}

if (args.has('--help') || args.has('-h')) {
  printHelp();
  process.exit(0);
}

if (args.has('--version') || args.has('-v')) {
  console.log(VERSION);
  process.exit(0);
}

if (args.has('--self-test')) {
  await runSelfTest();
  process.exit(0);
}

const server = createWebhoundMcpServer({
  apiKey: process.env.WEBHOUND_KEY || '',
  apiBase: process.env.WEBHOUND_API_BASE,
  appBase: process.env.WEBHOUND_APP_BASE,
  allowLocalFiles: true,
});

const transport = new StdioServerTransport();
await server.connect(transport);
