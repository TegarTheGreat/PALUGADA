/**
 * Tools from MCP servers, bound the way every capability is (F8, F13.4).
 *
 * Both audits put this first. PALUGADA served MCP to its own agent CLIs and
 * could use none: the integrations that already exist as MCP servers -- a
 * payment provider's, a CRM's, a messaging platform's -- were out of reach
 * unless an operator rewrote each one as a vendor file. This reaches them,
 * and does not let them in unsupervised.
 *
 * **An allow-list, not a catalogue.** The file names each server and, under
 * it, each tool this deployment may use, with its tier. A tool the server
 * offers and the file does not name does not exist here. A tool the file
 * names and the server no longer offers is refused when called.
 *
 * **A pin, so a tool cannot change under the operator.** A server that
 * rewrites a tool's description or arguments after it was approved -- the
 * "rug pull" MCP is known for -- changes what the model is told the tool does.
 * Each tool may carry the SHA-256 of what it looked like when it was bound;
 * one that no longer matches is refused at the call and reported by the
 * preflight. A write must be pinned.
 *
 * **Tiers the operator states, and the server may only raise.** A tool the
 * server marks destructive is tier 3 whatever the file says. A tool bound at
 * tier 0 must be one the server says only reads. A tool at tier 1 or above
 * must name a read-back -- another tool on the same server and what its answer
 * must say -- because F8.4 holds for every write, whoever's protocol it
 * arrives in.
 *
 * **Everything it returns is from outside.** Each tool is `readsOutside`, so
 * the work that called it asks the owner before its next tier 2 action
 * (F8.9), and what it said reaches the model inside the untrusted envelope.
 *
 * Streamable HTTP only: a POST per message, answered as JSON or as an event
 * stream. A stdio server is a process this platform would have to run with
 * the operator's environment, which is the thing F13.4 keeps runtimes from.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Ajv } from 'ajv';
import { PalugadaError } from '../errors.ts';
import { matcher, MATCH_RULE_SCHEMA, type MatchRule } from './vendors.ts';
import type { Tier } from '../domain/tier.ts';
import type { Capability, CapabilityContext, CapabilityRegistry } from '../broker/registry.ts';

const PROTOCOL_VERSION = '2025-06-18';
const CALL_TIMEOUT_MS = 60_000;
/** The largest answer read from a server; a tool that returns more is cut off, not buffered. */
const MAX_ANSWER_BYTES = 2 * 1024 * 1024;

export interface McpToolBinding {
  tier: Tier;
  /** `sha256:<hex>` of the tool as the server described it when it was bound. */
  pin?: string;
  /** Only for tier 0: the operator's word that it reads, when the server says nothing. */
  readOnly?: boolean;
  /** Required from tier 1: the tool that reads back what this one did, and what its answer must say. */
  verify?: {
    tool: string;
    /** Values may be `{input.x}` and `{result.x}`, whole or inside text. */
    arguments?: Record<string, unknown>;
    matches: MatchRule;
  };
}

export interface McpServerBinding {
  /** Letters, digits, `-` and `_`: it becomes part of every tool's name. */
  name: string;
  url: string;
  /** The division credential sent as `Authorization: Bearer`, resolved per call (F12.1). */
  credentialAlias?: string;
  /**
   * Or the server's own token, when it belongs to the deployment rather than
   * to a division: a secret reference, such as the `db://mcp-<name>` the
   * console seals. Opened for each call and for the boot's look at the tools.
   */
  tokenRef?: string;
  /** Where the server reads the token, when not `Authorization: Bearer`. */
  tokenIn?: TokenIn;
  tools: Record<string, McpToolBinding>;
}

/**
 * Where a server reads its token: another header (Exa's `x-api-key`),
 * another scheme (Sentry's `Sentry-Bearer`), or a query parameter
 * (Browserbase's `browserbaseApiKey`). Absent, it is `Authorization: Bearer`.
 */
export interface TokenIn {
  header?: string;
  scheme?: string;
  query?: string;
}

/** What a request to a server carries: its address, with the token in it when that is where it goes, and its headers. */
interface Access {
  url: string;
  headers: Record<string, string>;
}

/** The address and headers a server is reached with, the token placed where it reads it. */
export function accessFor(server: { url: string; tokenIn?: TokenIn }, token: string | null): Access {
  if (!token) return { url: server.url, headers: {} };
  const where = server.tokenIn ?? {};
  if (where.query) {
    const url = new URL(server.url);
    url.searchParams.set(where.query, token);
    return { url: url.toString(), headers: {} };
  }
  const scheme = where.scheme ?? (where.header ? '' : 'Bearer');
  return { url: server.url, headers: { [(where.header ?? 'authorization').toLowerCase()]: scheme ? `${scheme} ${token}` : token } };
}

export interface McpFile {
  servers: McpServerBinding[];
}

const FILE_SCHEMA = {
  type: 'object',
  required: ['servers'],
  additionalProperties: false,
  properties: {
    servers: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'url', 'tools'],
        additionalProperties: false,
        // One answer to whose authority a call carries, not two.
        not: { required: ['credentialAlias', 'tokenRef'] },
        properties: {
          name: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,30}$' },
          url: { type: 'string', pattern: '^https?://' },
          credentialAlias: { type: 'string', minLength: 1 },
          tokenRef: { type: 'string', pattern: '^[a-z][a-z0-9+.-]*://.+' },
          tokenIn: {
            type: 'object',
            additionalProperties: false,
            // A header or the address, not both.
            not: { required: ['header', 'query'] },
            properties: {
              header: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9-]{0,63}$' },
              scheme: { type: 'string', pattern: '^[A-Za-z0-9-]{0,32}$' },
              query: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_]{0,63}$' },
            },
          },
          tools: {
            type: 'object',
            minProperties: 1,
            additionalProperties: {
              type: 'object',
              required: ['tier'],
              additionalProperties: false,
              properties: {
                tier: { type: 'integer', minimum: 0, maximum: 3 },
                pin: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
                readOnly: { type: 'boolean' },
                verify: {
                  type: 'object',
                  required: ['tool', 'matches'],
                  additionalProperties: false,
                  properties: {
                    tool: { type: 'string', minLength: 1 },
                    arguments: { type: 'object' },
                    matches: MATCH_RULE_SCHEMA,
                  },
                },
              },
            },
          },
        },
      },
    },
  },
} as const;

const ajv = new Ajv({ allErrors: true, strict: false });
const validateFile = ajv.compile(FILE_SCHEMA);

/** What a server says a tool is. */
export interface McpToolDescription {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
}

/**
 * The fingerprint a pin compares: the name, the description and the
 * arguments, in a fixed order. What the model is told the tool does and what
 * it may send it -- the two things a server could change to change the tool.
 */
export function pinOf(tool: McpToolDescription): string {
  const canonical = JSON.stringify({
    name: tool.name,
    description: tool.description ?? '',
    inputSchema: sortKeys(tool.inputSchema ?? {}),
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]));
  }
  return value;
}

/** A capability name for a server's tool: `mcp.<server>.<tool>`, in the characters names use. */
export function mcpCapabilityName(server: string, tool: string): string {
  return `mcp.${server}.${tool.toLowerCase().replace(/[^a-z0-9_-]/g, '_')}`;
}

/* ---------------------------------------------------------- the session --- */

interface Session {
  id: string | null;
  protocol: string;
}

/**
 * One conversation with a server: initialize, then requests, then a DELETE
 * that ends it.
 *
 * A server may keep state in a session -- a browser keeps its open page, a
 * database its transaction -- so a task's calls share one (see `pooled`),
 * and a session no longer needed is ended rather than left for the server
 * to time out: Playwright's MCP server, for one, will not open a second
 * browser while the first session holds it.
 */
class McpConnection {
  readonly #url: string;
  readonly #headers: Record<string, string>;
  readonly #fetch: typeof fetch;
  #session: Session | null = null;
  #starting: Promise<void> | null = null;
  #next = 1;

  constructor(access: Access, fetcher: typeof fetch) {
    this.#url = access.url;
    this.#headers = access.headers;
    this.#fetch = fetcher;
  }

  async request(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    await this.#started(signal);
    let answered: { response: Response; id: number };
    try {
      answered = await this.#send(method, params, signal);
    } catch (failure) {
      if (!(failure instanceof SessionGone)) throw failure;
      // The server ended the session -- it restarted, or it closes idle
      // ones -- and says so with a 404, which means the request never ran.
      // The protocol's answer is a new session, and the request once more.
      this.#session = null;
      await this.#started(signal);
      answered = await this.#send(method, params, signal);
    }
    const message = await this.#answerTo(answered.response, answered.id);
    if (message.error) {
      const error = message.error as { code?: number; message?: string };
      throw new Error(`the MCP server refused ${method}: ${error.message ?? 'no message'} (${error.code ?? '?'})`);
    }
    return (message.result ?? {}) as Record<string, unknown>;
  }

  /** Ends the session, if the server gave one. A server may refuse (405); it is ended on this side either way. */
  async close(): Promise<void> {
    const session = this.#session;
    this.#session = null;
    if (!session?.id) return;
    await this.#fetch(this.#url, {
      method: 'DELETE',
      headers: {
        'mcp-session-id': session.id,
        'mcp-protocol-version': session.protocol,
        ...this.#headers,
      },
      signal: AbortSignal.timeout(5_000),
    }).then((response) => response.body?.cancel(), () => undefined);
  }

  async #send(method: string, params: Record<string, unknown>, signal: AbortSignal | undefined): Promise<{ response: Response; id: number }> {
    const id = this.#next++;
    return { response: await this.#post({ jsonrpc: '2.0', id, method, params }, signal), id };
  }

  /** One initialize at a time: two calls in one task may arrive together. */
  async #started(signal: AbortSignal | undefined): Promise<void> {
    if (this.#session) return;
    this.#starting ??= this.#initialize(signal).finally(() => {
      this.#starting = null;
    });
    await this.#starting;
  }

  async #initialize(signal: AbortSignal | undefined): Promise<void> {
    const id = this.#next++;
    const response = await this.#post({
      jsonrpc: '2.0',
      id,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'palugada', version: '1' },
      },
    }, signal);
    const sessionId = response.headers.get('mcp-session-id');
    const message = await this.#answerTo(response, id);
    if (message.error) throw new Error(`the MCP server refused to start a session: ${JSON.stringify(message.error)}`);
    const result = (message.result ?? {}) as { protocolVersion?: string };
    this.#session = { id: sessionId, protocol: result.protocolVersion ?? PROTOCOL_VERSION };
    // Sampling, elicitation and roots are not offered: a server may not ask
    // this platform's model anything, ask the owner anything, or read files.
    await this.#post({ jsonrpc: '2.0', method: 'notifications/initialized' }, signal);
  }

  async #post(message: Record<string, unknown>, signal: AbortSignal | undefined): Promise<Response> {
    const timeout = AbortSignal.timeout(CALL_TIMEOUT_MS);
    const response = await this.#fetch(this.#url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...this.#headers,
        ...(this.#session?.id ? { 'mcp-session-id': this.#session.id } : {}),
        ...(this.#session ? { 'mcp-protocol-version': this.#session.protocol } : {}),
      },
      body: JSON.stringify(message),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (response.status === 404 && this.#session?.id && message.method !== 'initialize') {
      await response.body?.cancel();
      throw new SessionGone();
    }
    if (!response.ok && response.status !== 202) {
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      throw new Error(`the MCP server answered ${response.status}: ${detail}`);
    }
    return response;
  }

  /** The JSON-RPC answer with this id, from a JSON body or an event stream. */
  async #answerTo(response: Response, id: number): Promise<Record<string, unknown>> {
    const text = await boundedText(response);
    const type = response.headers.get('content-type') ?? '';
    const messages: unknown[] = [];
    if (type.includes('text/event-stream')) {
      for (const event of text.split(/\r?\n\r?\n/)) {
        const data = event.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
        if (data) messages.push(JSON.parse(data));
      }
    } else {
      const parsed: unknown = JSON.parse(text);
      messages.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    }
    const answer = messages.find((one) => (one as { id?: unknown }).id === id);
    if (!answer) throw new Error('the MCP server did not answer the request it was sent');
    return answer as Record<string, unknown>;
  }
}

/** A 404 for a session the server has ended. */
class SessionGone extends Error {}

/** A task's sessions, by server, task and the authority its calls carry. */
const sessions = new Map<string, { connection: McpConnection; timer: NodeJS.Timeout }>();
/** A task quiet for this long has its sessions ended; its next call starts another. */
const SESSION_IDLE_MS = 5 * 60_000;
/** Past this many, the longest idle is ended: a server's resources are not this platform's to hold. */
const MAX_SESSIONS = 64;

/**
 * The session a task's calls to one server share: its write and the read-back
 * that checks it, a browser's page from one step to the next. Keyed by the
 * authority the calls carry as well as by the task, so a session is never
 * carried into another task or another division's credential.
 */
function pooled(key: string, open: () => McpConnection, idleMs: number): McpConnection {
  const held = sessions.get(key);
  const connection = held?.connection ?? open();
  if (held) clearTimeout(held.timer);
  sessions.delete(key);
  const timer = setTimeout(() => {
    if (sessions.get(key)?.connection === connection) sessions.delete(key);
    void connection.close();
  }, idleMs);
  timer.unref();
  sessions.set(key, { connection, timer });
  while (sessions.size > MAX_SESSIONS) {
    const [oldest, entry] = sessions.entries().next().value!;
    clearTimeout(entry.timer);
    sessions.delete(oldest);
    void entry.connection.close();
  }
  return connection;
}

/** Ends every session a task still holds: at shutdown, so no server is left holding a browser for nobody. */
export async function closeMcpSessions(): Promise<void> {
  const open = [...sessions.values()];
  sessions.clear();
  for (const entry of open) clearTimeout(entry.timer);
  await Promise.all(open.map((entry) => entry.connection.close()));
}

/** Lists a server's tools in a session of its own, ended afterwards. */
async function toolsOnce(access: Access, fetcher: typeof fetch, signal?: AbortSignal): Promise<McpToolDescription[]> {
  const connection = new McpConnection(access, fetcher);
  try {
    return await listTools(connection, signal);
  } finally {
    await connection.close();
  }
}

async function boundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_ANSWER_BYTES) {
      await reader.cancel();
      throw new Error(`the MCP server's answer is larger than ${MAX_ANSWER_BYTES} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/* ------------------------------------------------------------ the tools --- */

async function listTools(connection: McpConnection, signal?: AbortSignal): Promise<McpToolDescription[]> {
  const tools: McpToolDescription[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const result = await connection.request('tools/list', cursor ? { cursor } : {}, signal);
    tools.push(...((result.tools ?? []) as McpToolDescription[]));
    cursor = typeof result.nextCursor === 'string' ? result.nextCursor : undefined;
    if (!cursor) break;
  }
  return tools;
}

/** What a tool call answered, as data: its structured result, or its text parsed if it is JSON. */
function outputOf(result: Record<string, unknown>): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const texts = ((result.content ?? []) as Array<{ type?: string; text?: string }>)
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text!);
  const joined = texts.join('\n');
  try {
    return JSON.parse(joined);
  } catch {
    return { text: joined };
  }
}

function fillArguments(template: unknown, values: { input: unknown; result: unknown }): unknown {
  const read = (path: string): unknown => {
    let value: unknown = values;
    for (const segment of path.split('.')) {
      if (value === null || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, segment)) return undefined;
      value = (value as Record<string, unknown>)[segment];
    }
    return value;
  };
  if (typeof template === 'string') {
    const whole = /^\{((?:input|result)(?:\.[A-Za-z0-9_-]+)*)\}$/.exec(template);
    if (whole) return read(whole[1]!);
    return template.replace(/\{((?:input|result)(?:\.[A-Za-z0-9_-]+)*)\}/g, (literal, path: string) => {
      const found = read(path);
      return found === undefined ? literal : String(found);
    });
  }
  if (Array.isArray(template)) return template.map((item) => fillArguments(item, values));
  if (template && typeof template === 'object') {
    return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, fillArguments(value, values)]));
  }
  return template;
}

export interface McpOptions {
  fetch?: typeof fetch;
  /** Opens a server's `tokenRef`; without it such a server is refused at the call rather than sent bare. */
  resolve?: (reference: string) => Promise<string>;
  /** How long a quiet task keeps its session; five minutes unless a test says otherwise. */
  sessionIdleMs?: number;
}

/** The server reached with its own token, when it has one. */
async function serverAccess(server: McpServerBinding, options: McpOptions): Promise<Access> {
  if (!server.tokenRef) return accessFor(server, null);
  if (!options.resolve) {
    throw new PalugadaError('credential.unavailable', `${server.name} has a token, and nothing here can open ${server.tokenRef}`, {});
  }
  return accessFor(server, await options.resolve(server.tokenRef));
}

/** What a tool's arguments are called, for the owner to read. */
function argumentNames(tool: McpToolDescription): string[] {
  const properties = (tool.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  return properties && typeof properties === 'object' ? Object.keys(properties) : [];
}

/** What the console shows of one tool before the owner allows it. */
export interface McpToolOffered {
  name: string;
  description: string;
  arguments: string[];
  reads: boolean;
  destructive: boolean;
  /** Where the rules let it start: 0 for what only reads, 3 for what the server calls destructive, 2 otherwise. */
  suggestedTier: Tier;
}

/**
 * What a server offers, as the owner sees it before allowing any of it: each
 * tool, what it does, and what the server says of it. The pins are not
 * shown: the console takes them from the server when it saves.
 */
export async function offeredTools(access: Access, options: McpOptions = {}): Promise<McpToolOffered[]> {
  const tools = await toolsOnce(access, options.fetch ?? globalThis.fetch, AbortSignal.timeout(30_000));
  return tools.map((tool) => {
    const reads = tool.annotations?.readOnlyHint === true;
    const destructive = tool.annotations?.destructiveHint === true;
    return {
      name: tool.name,
      description: (tool.description ?? '').slice(0, 1_000),
      arguments: argumentNames(tool),
      reads,
      destructive,
      suggestedTier: (destructive ? 3 : reads ? 0 : 2) as Tier,
    };
  });
}

/** Each tool as the server describes it now, to pin a binding the owner chose in the console. */
export async function currentPins(access: Access, options: McpOptions = {}): Promise<Map<string, string>> {
  const tools = await toolsOnce(access, options.fetch ?? globalThis.fetch, AbortSignal.timeout(30_000));
  return new Map(tools.map((tool) => [tool.name, pinOf(tool)]));
}

/**
 * The capability for one tool of one server.
 *
 * `listed` is what the server said at boot, when it answered without a
 * credential; without it the tool is offered with the arguments its binding
 * does not know, and the pin is checked at the first call instead.
 */
export function mcpCapability(
  server: McpServerBinding,
  toolName: string,
  binding: McpToolBinding,
  listed: McpToolDescription | undefined,
  options: McpOptions = {},
): Capability<Record<string, unknown>, unknown> {
  const fetcher = options.fetch ?? globalThis.fetch;
  const name = mcpCapabilityName(server.name, toolName);
  /**
   * The session for this call: the task's own when there is a task, and one
   * ended straight after for the preflight, which has none.
   */
  const connect = async (ctx: { companyId?: string; taskId?: string; credential?: (alias: string) => Promise<string> }) => {
    let access: Access;
    if (server.credentialAlias) {
      access = accessFor(server, ctx.credential ? await ctx.credential(server.credentialAlias) : null);
    } else {
      access = await serverAccess(server, options);
    }
    const open = () => new McpConnection(access, fetcher);
    if (!ctx.taskId) {
      const connection = open();
      return { connection, done: () => connection.close() };
    }
    const authority = createHash('sha256').update(JSON.stringify(access)).digest('hex').slice(0, 16);
    const key = [server.name, server.url, ctx.companyId ?? '', ctx.taskId, authority].join('\n');
    return { connection: pooled(key, open, options.sessionIdleMs ?? SESSION_IDLE_MS), done: async () => undefined };
  };

  /** The tool as the server describes it now, held to the pin. */
  const current = async (connection: McpConnection, signal?: AbortSignal): Promise<McpToolDescription> => {
    const tool = (await listTools(connection, signal)).find((one) => one.name === toolName);
    if (!tool) {
      throw new PalugadaError('capability.disabled', `${server.name} no longer offers ${toolName}`, { name });
    }
    if (binding.pin && pinOf(tool) !== binding.pin) {
      throw new PalugadaError('capability.disabled',
        `${server.name} has changed ${toolName} since it was pinned (now ${pinOf(tool)}); `
          + 'read what it does now, and pin it again if it is still the tool you meant',
        { name, pin: pinOf(tool) });
    }
    if (tool.annotations?.destructiveHint === true && binding.tier < 3) {
      throw new PalugadaError('capability.miscalibrated',
        `${server.name} now says ${toolName} is destructive; it is bound at tier ${binding.tier}`, { name });
    }
    return tool;
  };

  const call = async (connection: McpConnection, tool: string, args: unknown, key: string, signal?: AbortSignal): Promise<unknown> => {
    const result = await connection.request('tools/call', {
      name: tool,
      arguments: args ?? {},
      // MCP has no idempotency key of its own. Sent where the protocol keeps
      // what a client wants a server to know about a call; a server that
      // honours it recognises a retry, and one that does not is why the
      // journal and the owner's approval are spent before the call.
      _meta: { 'palugada/idempotencyKey': key },
    }, signal);
    if (result.isError === true) {
      const text = ((result.content ?? []) as Array<{ text?: string }>).map((part) => part.text ?? '').join(' ').slice(0, 500);
      throw new Error(`${server.name} ${tool} failed: ${text || 'no reason given'}`);
    }
    return outputOf(result);
  };

  const capability: Capability<Record<string, unknown>, unknown> = {
    name,
    adapter: `mcp:${server.name}`,
    defaultTier: binding.tier,
    readsOutside: true,
    ...(listed?.inputSchema ? { inputSchema: listed.inputSchema } : {}),
    async execute(input, ctx: CapabilityContext) {
      const { connection, done } = await connect(ctx);
      try {
        await current(connection, ctx.signal);
        return await call(connection, toolName, input, ctx.idempotencyKey, ctx.signal);
      } finally {
        await done();
      }
    },
    async preflight(ctx) {
      try {
        const { connection, done } = await connect({
          ...(ctx.credential ? { credential: (alias: string) => ctx.credential!(alias, name) } : {}),
        });
        try {
          await current(connection);
        } finally {
          await done();
        }
        return { ok: true };
      } catch (failure) {
        return { ok: false, detail: (failure as Error).message };
      }
    },
  };

  if (binding.verify) {
    const verify = binding.verify;
    const matches = matcher(verify.matches);
    capability.verify = async (input, result, ctx) => {
      // The task's own session: what the write left in it -- a browser's
      // page -- is what the read-back reads.
      const { connection, done } = await connect(ctx);
      try {
        const answer = await call(connection, verify.tool, fillArguments(verify.arguments ?? {}, { input, result }), `${ctx.idempotencyKey}:verify`, ctx.signal);
        return matches({ status: 200, body: answer }, result, input);
      } finally {
        await done();
      }
    };
  }
  return capability;
}

/* --------------------------------------------------------------- binding --- */

/**
 * Reads the file, asks each server what it offers, and registers the tools
 * the file names. Returns what it registered, by name, and what it could not
 * check, for the boot notes.
 *
 * A file that is wrong stops the boot, as the vendor file does: an operator
 * who believes a tool is bound should not find out from an agent's refusal.
 * A server that does not answer does not: it is somebody else's machine, and
 * its tools are checked again at every call.
 */
export async function registerMcpServers(
  registry: CapabilityRegistry,
  path: string,
  options: McpOptions = {},
): Promise<{ bound: string[]; notes: string[] }> {
  let document: unknown;
  try {
    document = JSON.parse(await readFile(path, 'utf8'));
  } catch (failure) {
    throw new PalugadaError('config.invalid', `${path} could not be read as JSON: ${(failure as Error).message}`, { source: path });
  }
  return bindMcpServers(registry, document, path, options);
}

export async function bindMcpServers(
  registry: CapabilityRegistry,
  document: unknown,
  source: string,
  options: McpOptions = {},
): Promise<{ bound: string[]; notes: string[] }> {
  if (!validateFile(document)) {
    const first = validateFile.errors?.[0];
    throw new PalugadaError('config.invalid',
      `${source} is not a valid MCP file: ${first?.instancePath || '(root)'} ${first?.message ?? 'did not validate'}`,
      { source });
  }
  const refuse = (why: string): never => {
    throw new PalugadaError('config.invalid', `${source}: ${why}`, { source });
  };
  const file = document as McpFile;
  const bound: string[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();

  for (const server of file.servers) {
    if (seen.has(server.name)) refuse(`names the server ${server.name} twice`);
    seen.add(server.name);

    // What the server offers, when it will say without a division's
    // credential. Many will not, and that is not a reason to refuse the file.
    let listed: McpToolDescription[] | null = null;
    try {
      listed = await toolsOnce(await serverAccess(server, options), options.fetch ?? globalThis.fetch);
    } catch (failure) {
      notes.push(`${server.name}: could not list its tools at boot (${(failure as Error).message}); each is checked at its first call`);
    }

    // Every tool is checked before any is registered, so a server refused
    // for one tool leaves nothing of itself behind -- the console's servers
    // are bound one at a time, and a refused one is left out whole.
    const accepted: Array<{ capability: Capability<Record<string, unknown>, unknown>; unpinned: string | null }> = [];
    for (const [toolName, binding] of Object.entries(server.tools)) {
      const described = listed?.find((tool) => tool.name === toolName);
      if (listed && !described) refuse(`${server.name} does not offer a tool named ${toolName}`);
      if (binding.tier >= 1 && !binding.pin) {
        refuse(`${server.name} ${toolName} writes at tier ${binding.tier} and is not pinned; pin it to what it is now`
          + (described ? ` (${pinOf(described)})` : ''));
      }
      if (binding.tier >= 1 && !binding.verify) {
        refuse(`${server.name} ${toolName} writes at tier ${binding.tier} and names no read-back (F8.4)`);
      }
      if (binding.tier === 0) {
        const reads = described ? described.annotations?.readOnlyHint === true : binding.readOnly === true;
        if (!reads) {
          refuse(`${server.name} ${toolName} is bound at tier 0, and `
            + (described ? 'the server does not say it only reads' : 'nothing says it only reads (set readOnly after checking)'));
        }
      }
      if (described?.annotations?.destructiveHint === true && binding.tier < 3) {
        refuse(`${server.name} says ${toolName} is destructive; bind it at tier 3`);
      }
      if (binding.verify && listed && !listed.some((tool) => tool.name === binding.verify!.tool)) {
        refuse(`${server.name} ${toolName} reads back with ${binding.verify.tool}, which the server does not offer`);
      }
      if (described && binding.pin && pinOf(described) !== binding.pin) {
        refuse(`${server.name} has changed ${toolName} since it was pinned (now ${pinOf(described)})`);
      }
      const capability = mcpCapability(server, toolName, binding, described, options);
      if (registry.get(capability.name)) refuse(`${capability.name} is already bound in this deployment`);
      accepted.push({ capability, unpinned: !binding.pin && described ? pinOf(described) : null });
    }
    for (const { capability, unpinned } of accepted) {
      registry.register(capability);
      bound.push(capability.name);
      if (unpinned) notes.push(`${capability.name} is not pinned; its pin now is ${unpinned}`);
    }
  }
  return { bound, notes };
}
