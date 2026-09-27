/**
 * An MCP server over streamable HTTP for the tests: a payment provider's four
 * tools, one of which only reads, one writes, one reads a write back, and one
 * is destructive. Some answers come as an event stream, as servers send them.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { McpToolDescription } from '../../src/capabilities/mcp.ts';

export const TOOLS: McpToolDescription[] = [
  {
    name: 'get_transaction',
    description: 'Reads a transaction by its order id.',
    inputSchema: { type: 'object', required: ['orderId'], properties: { orderId: { type: 'string' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'create_payment_link',
    description: 'Creates a payment link for an amount in rupiah.',
    inputSchema: { type: 'object', required: ['amount'], properties: { amount: { type: 'integer' } } },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'get_payment_link',
    description: 'Reads a payment link.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'refund_everything',
    description: 'Refunds every transaction.',
    inputSchema: { type: 'object' },
    annotations: { destructiveHint: true },
  },
];

export async function mcpServer(options: { needsToken?: string; tools?: McpToolDescription[] } = {}) {
  const state = {
    tools: options.tools ?? structuredClone(TOOLS),
    calls: [] as Array<{ name: string; arguments: Record<string, unknown>; meta: unknown; authorization: string | undefined }>,
    links: new Map<string, { id: string; amount: number; status: string }>(),
    /** The Authorization header of every request, so a test can see where a token went. */
    authorizations: [] as Array<string | undefined>,
  };
  const server: Server = createServer((req: IncomingMessage, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const message = JSON.parse(raw) as { id?: number; method: string; params?: Record<string, unknown> };
      state.authorizations.push(req.headers.authorization);
      if (options.needsToken && req.headers.authorization !== `Bearer ${options.needsToken}`) {
        res.writeHead(401).end('{"error":"unauthorised"}');
        return;
      }
      if (message.method === 'notifications/initialized') {
        res.writeHead(202).end();
        return;
      }
      if (message.method !== 'initialize' && req.headers['mcp-session-id'] !== 'session-1') {
        res.writeHead(400).end('{"error":"no session"}');
        return;
      }
      const answer = (result: unknown, stream = false) => {
        const body = JSON.stringify({ jsonrpc: '2.0', id: message.id, result });
        if (stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(`event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\nevent: message\ndata: ${body}\n\n`);
        } else {
          res.writeHead(200, { 'content-type': 'application/json', ...(message.method === 'initialize' ? { 'mcp-session-id': 'session-1' } : {}) });
          res.end(body);
        }
      };
      if (message.method === 'initialize') {
        answer({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-payments', version: '1' } });
        return;
      }
      if (message.method === 'tools/list') {
        answer({ tools: state.tools }, true);
        return;
      }
      if (message.method === 'tools/call') {
        const params = message.params as { name: string; arguments: Record<string, unknown>; _meta?: unknown };
        state.calls.push({ name: params.name, arguments: params.arguments, meta: params._meta, authorization: req.headers.authorization });
        if (params.name === 'get_transaction') {
          answer({ content: [{ type: 'text', text: 'settled' }], structuredContent: { orderId: params.arguments.orderId, status: 'settlement' } });
        } else if (params.name === 'create_payment_link') {
          const link = { id: `pl_${state.links.size + 1}`, amount: Number(params.arguments.amount), status: 'active' };
          state.links.set(link.id, link);
          answer({ content: [{ type: 'text', text: JSON.stringify(link) }] }, true);
        } else if (params.name === 'get_payment_link') {
          const link = state.links.get(String(params.arguments.id));
          answer(link ? { content: [{ type: 'text', text: JSON.stringify(link) }] } : { isError: true, content: [{ type: 'text', text: 'no such link' }] });
        } else {
          answer({ isError: true, content: [{ type: 'text', text: 'unknown tool' }] });
        }
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'no' } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  return { url, state, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
