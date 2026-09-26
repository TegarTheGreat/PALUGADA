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
  tools: Record<string, McpToolBinding>;
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
        properties: {
          name: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,30}$' },
          url: { type: 'string', pattern: '^https?://' },
          credentialAlias: { type: 'string', minLength: 1 },
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
 * One conversation with a server: initialize, then requests.
 *
 * A session per call rather than one kept open. A capability runs for one
 * division with that division's credential, and a session held across calls
 * would carry one division's authority into another's.
 */
class McpConnection {
  readonly #url: string;
  readonly #authorization: string | null;
  readonly #signal: AbortSignal | undefined;
  readonly #fetch: typeof fetch;
  #session: Session | null = null;
  #next = 1;

  constructor(url: string, authorization: string | null, signal: AbortSignal | undefined, fetcher: typeof fetch) {
    this.#url = url;
    this.#authorization = authorization;
    this.#signal = signal;
    this.#fetch = fetcher;
  }

  async request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.#session && method !== 'initialize') await this.#initialize();
    const id = this.#next++;
    const response = await this.#post({ jsonrpc: '2.0', id, method, params });
    const message = await this.#answerTo(response, id);
    if (message.error) {
      const error = message.error as { code?: number; message?: string };
      throw new Error(`the MCP server refused ${method}: ${error.message ?? 'no message'} (${error.code ?? '?'})`);
    }
    return (message.result ?? {}) as Record<string, unknown>;
  }

  async #initialize(): Promise<void> {
    const response = await this.#post({
      jsonrpc: '2.0',
      id: this.#next++,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'palugada', version: '1' },
      },
    });
    const sessionId = response.headers.get('mcp-session-id');
    const message = await this.#answerTo(response, this.#next - 1);
    if (message.error) throw new Error(`the MCP server refused to start a session: ${JSON.stringify(message.error)}`);
    const result = (message.result ?? {}) as { protocolVersion?: string };
    this.#session = { id: sessionId, protocol: result.protocolVersion ?? PROTOCOL_VERSION };
    // Sampling, elicitation and roots are not offered: a server may not ask
    // this platform's model anything, ask the owner anything, or read files.
    await this.#post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  async #post(message: Record<string, unknown>): Promise<Response> {
    const timeout = AbortSignal.timeout(CALL_TIMEOUT_MS);
    const response = await this.#fetch(this.#url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(this.#authorization ? { authorization: this.#authorization } : {}),
        ...(this.#session?.id ? { 'mcp-session-id': this.#session.id } : {}),
        ...(this.#session ? { 'mcp-protocol-version': this.#session.protocol } : {}),
      },
      body: JSON.stringify(message),
      signal: this.#signal ? AbortSignal.any([this.#signal, timeout]) : timeout,
    });
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

async function listTools(connection: McpConnection): Promise<McpToolDescription[]> {
  const tools: McpToolDescription[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const result = await connection.request('tools/list', cursor ? { cursor } : {});
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
  const connect = async (ctx: { signal?: AbortSignal; credential?: (alias: string) => Promise<string> }) => {
    const token = server.credentialAlias && ctx.credential ? await ctx.credential(server.credentialAlias) : null;
    return new McpConnection(server.url, token ? `Bearer ${token}` : null, ctx.signal, fetcher);
  };

  /** The tool as the server describes it now, held to the pin. */
  const current = async (connection: McpConnection): Promise<McpToolDescription> => {
    const tool = (await listTools(connection)).find((one) => one.name === toolName);
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

  const call = async (connection: McpConnection, tool: string, args: unknown, key: string): Promise<unknown> => {
    const result = await connection.request('tools/call', {
      name: tool,
      arguments: args ?? {},
      // MCP has no idempotency key of its own. Sent where the protocol keeps
      // what a client wants a server to know about a call; a server that
      // honours it recognises a retry, and one that does not is why the
      // journal and the owner's approval are spent before the call.
      _meta: { 'palugada/idempotencyKey': key },
    });
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
      const connection = await connect(ctx);
      await current(connection);
      return call(connection, toolName, input, ctx.idempotencyKey);
    },
    async preflight(ctx) {
      try {
        const connection = await connect({
          ...(ctx.credential ? { credential: (alias: string) => ctx.credential!(alias, name) } : {}),
        });
        await current(connection);
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
      const connection = await connect(ctx);
      const answer = await call(connection, verify.tool, fillArguments(verify.arguments ?? {}, { input, result }), `${ctx.idempotencyKey}:verify`);
      return matches({ status: 200, body: answer }, result, input);
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
      listed = await listTools(new McpConnection(server.url, null, undefined, options.fetch ?? globalThis.fetch));
    } catch (failure) {
      notes.push(`${server.name}: could not list its tools at boot (${(failure as Error).message}); each is checked at its first call`);
    }

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
      registry.register(capability);
      bound.push(capability.name);
      if (!binding.pin && described) notes.push(`${capability.name} is not pinned; its pin now is ${pinOf(described)}`);
    }
  }
  return { bound, notes };
}
