import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createWebhoundMcpServer } from './server.mjs';

export async function handleMcpHttpRequest(req, res, options = {}) {
  const server = createWebhoundMcpServer({ ...options, allowLocalFiles: false });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
  } catch (error) {
    await transport.close().catch(() => {});
    await server.close().catch(() => {});
    throw error;
  }
}
