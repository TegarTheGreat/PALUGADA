/**
 * The tool bridge (PRD v2 F13.4).
 *
 * Some runtimes -- Claude Code among them -- do not ask for a tool by writing
 * an event on stdout. They speak MCP, and they expect to reach a server. F13.4
 * says a tool call always comes back to the engine and that a runtime never
 * holds an MCP client with credentials in it, so the server they reach is this
 * one: an in-process listener whose every tool is a name over `callTool`, which
 * is the broker, which is where the secrets are.
 *
 * It binds to loopback on an ephemeral port and requires a bearer token minted
 * for the one run. Both matter for different reasons: loopback keeps it off the
 * network, and the token keeps it from being useful to anything else that
 * happens to be running on this machine. The token is generated per run and
 * never reused, so a runtime that keeps its copy holds something that expired
 * when the run did.
 *
 * It is deliberately a small MCP server rather than a general one. It answers
 * `initialize`, `tools/list` and `tools/call` and refuses everything else,
 * because every additional method is a thing a compromised runtime could ask
 * for, and none of the others are needed to hand over a list of names.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { PalugadaError } from '../errors.ts';
import type { RunServices, ToolDeclaration } from './protocol.ts';

const PROTOCOL_VERSION = '2024-11-05';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface ToolBridge {
  /** What the runtime is configured to reach. */
  url: string;
  token: string;
  /** Every tool call that came through, in order. For tests and for F11.1. */
  readonly calls: ReadonlyArray<{ name: string; input: unknown }>;
  close(): Promise<void>;
}

export async function startToolBridge(
  tools: ToolDeclaration[],
  services: RunServices,
): Promise<ToolBridge> {
  const token = randomBytes(32).toString('hex');
  const calls: Array<{ name: string; input: unknown }> = [];
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      // A handler that throws has already failed to answer; the connection is
      // ended rather than left open, because a runtime waiting on a socket that
      // will never speak is worse than one that gets an error.
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal error' }));
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!authorised(req, token)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorised' }));
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'method not allowed' }));
      return;
    }

    const body = await readBody(req);
    let message: JsonRpcRequest;
    try {
      message = JSON.parse(body) as JsonRpcRequest;
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'malformed json' }));
      return;
    }

    // A notification has no id and wants no answer. `notifications/initialized`
    // is the one that actually arrives.
    if (message.id === undefined || message.id === null) {
      res.writeHead(202).end();
      return;
    }

    const answer = await dispatch(message);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(answer));
  }

  async function dispatch(message: JsonRpcRequest): Promise<unknown> {
    const { id, method } = message;

    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'palugada-broker', version: '1' },
        },
      };
    }

    if (method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: tools.map((tool) => ({
            name: tool.name,
            // The tier is in the description because a runtime deciding
            // whether to attempt something should know that tier 3 means the
            // owner will be asked. It is advice, not enforcement: the broker
            // decides regardless of what the runtime believed.
            description: `PALUGADA capability ${tool.name} (tier ${tool.tier}).`,
            inputSchema: tool.inputSchema,
          })),
        },
      };
    }

    if (method === 'tools/call') {
      const params = (message.params ?? {}) as { name?: string; arguments?: unknown };
      const name = String(params.name ?? '');

      if (!byName.has(name)) {
        // Not an exception: F2.4 says a tool outside the role's allow-list is
        // refused, and a refusal the runtime can read is more useful than a
        // transport error it has to guess about.
        return toolError(id, `capability ${name} is not available to this role`);
      }

      calls.push({ name, input: params.arguments });
      try {
        const output = await services.callTool(name, params.arguments);
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(output) }],
            isError: false,
          },
        };
      } catch (error) {
        const detail =
          error instanceof PalugadaError
            ? `${error.code}: ${error.message}`
            : (error as Error).message;
        return toolError(id, detail);
      }
    }

    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `method ${method} is not supported` },
    };
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('tool bridge did not bind to a port');
  }

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    token,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * A refused or failed tool call, reported the way MCP reports one.
 *
 * `isError` rather than a JSON-RPC error, because a denial is a fact about the
 * action rather than a fault in the call. A runtime that receives a transport
 * error learns that something broke; one that receives this learns that it was
 * refused and why, which is the difference between retrying blindly and
 * changing its mind.
 */
function toolError(id: JsonRpcRequest['id'], message: string): unknown {
  return {
    jsonrpc: '2.0',
    id,
    result: { content: [{ type: 'text', text: message }], isError: true },
  };
}

function authorised(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  // Length is compared separately because `timingSafeEqual` throws on a
  // mismatch, and a thrown comparison is a failed comparison either way.
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // A megabyte is far more than a tool call needs and far less than enough
    // to exhaust the orchestrator.
    if (size > 1_048_576) throw new Error('request body is too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}
